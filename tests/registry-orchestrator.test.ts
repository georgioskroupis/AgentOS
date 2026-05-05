import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { acquireProjectRunnerLock, releaseProjectRunnerLock } from "../src/registry.js";
import { RegistryOrchestrator, type ProjectOrchestrator } from "../src/registry-orchestrator.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import type { Issue } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("registry orchestrator", () => {
  it("dispatches fairly across two fake projects under the global cap after restart", async () => {
    const { registryPath, repos } = await fakeRegistry([
      { name: "alpha", maxConcurrency: 1 },
      { name: "beta", maxConcurrency: 1 }
    ]);
    const fakes = new Map([
      ["alpha", new FakeProjectOrchestrator([1, 1])],
      ["beta", new FakeProjectOrchestrator([1, 1])]
    ]);
    const service = new RegistryOrchestrator({
      registryPath,
      maxConcurrency: 1,
      createProjectOrchestrator: (context) => fakes.get(context.name)!
    });

    const first = await service.runOnce(false);
    const second = await new RegistryOrchestrator({
      registryPath,
      maxConcurrency: 1,
      createProjectOrchestrator: (context) => fakes.get(context.name)!
    }).runOnce(false);

    expect(first.summaries.map((summary) => [summary.name, summary.status, summary.dispatched])).toEqual([
      ["alpha", "dispatched", 1],
      ["beta", "global_capacity_exhausted", 0]
    ]);
    expect(second.summaries.map((summary) => [summary.name, summary.status, summary.dispatched])).toEqual([
      ["alpha", "global_capacity_exhausted", 0],
      ["beta", "dispatched", 1]
    ]);
    expect(fakes.get("alpha")?.limits).toEqual([1, 0]);
    expect(fakes.get("beta")?.limits).toEqual([0, 1]);
    expect(repos.alpha).toBeTruthy();
  });

  it("continues scheduling another project when one project has no work", async () => {
    const { registryPath } = await fakeRegistry([
      { name: "empty", maxConcurrency: 1 },
      { name: "active", maxConcurrency: 1 }
    ]);
    const fakes = new Map([
      ["empty", new FakeProjectOrchestrator([0])],
      ["active", new FakeProjectOrchestrator([1])]
    ]);

    const result = await new RegistryOrchestrator({
      registryPath,
      maxConcurrency: 1,
      createProjectOrchestrator: (context) => fakes.get(context.name)!
    }).runOnce(false);

    expect(result.summaries.map((summary) => [summary.name, summary.status, summary.dispatched])).toEqual([
      ["empty", "idle", 0],
      ["active", "dispatched", 1]
    ]);
  });

  it("enforces per-project concurrency before dispatching", async () => {
    const { registryPath, repos } = await fakeRegistry([
      { name: "busy", maxConcurrency: 1 },
      { name: "open", maxConcurrency: 1 }
    ]);
    await new RuntimeStateStore(repos.busy).upsertActiveRun({
      issueId: "busy-1",
      identifier: "BUSY-1",
      issue: fakeIssue("busy-1", "BUSY-1"),
      attempt: null,
      startedAt: "2026-05-05T00:00:00.000Z"
    });
    const fakes = new Map([
      ["busy", new FakeProjectOrchestrator([1])],
      ["open", new FakeProjectOrchestrator([1])]
    ]);

    const result = await new RegistryOrchestrator({
      registryPath,
      maxConcurrency: 2,
      createProjectOrchestrator: (context) => fakes.get(context.name)!
    }).runOnce(false);

    expect(result.summaries.map((summary) => [summary.name, summary.status, summary.dispatched])).toEqual([
      ["busy", "project_capacity_exhausted", 0],
      ["open", "dispatched", 1]
    ]);
    expect(fakes.get("busy")?.limits).toEqual([0]);
    expect(fakes.get("open")?.limits).toEqual([1]);
  });

  it("recomputes global capacity after startup recovery clears stale active runs", async () => {
    const { registryPath, repos } = await fakeRegistry([
      { name: "alpha", maxConcurrency: 1 },
      { name: "beta", maxConcurrency: 1 }
    ]);
    await new RuntimeStateStore(repos.alpha).upsertActiveRun({
      issueId: "alpha-1",
      identifier: "ALPHA-1",
      issue: fakeIssue("alpha-1", "ALPHA-1"),
      attempt: null,
      startedAt: "2026-05-05T00:00:00.000Z"
    });
    const fakes = new Map([
      [
        "alpha",
        new FakeProjectOrchestrator([0], undefined, async () => {
          await new RuntimeStateStore(repos.alpha).removeActiveRun("alpha-1");
        })
      ],
      ["beta", new FakeProjectOrchestrator([1])]
    ]);

    const result = await new RegistryOrchestrator({
      registryPath,
      maxConcurrency: 1,
      createProjectOrchestrator: (context) => fakes.get(context.name)!
    }).runOnce(false);

    expect(result.summaries.map((summary) => [summary.name, summary.status, summary.dispatched])).toEqual([
      ["alpha", "idle", 0],
      ["beta", "dispatched", 1]
    ]);
    expect(fakes.get("alpha")?.limits).toEqual([0]);
    expect(fakes.get("beta")?.limits).toEqual([1]);
  });

  it("records transient tracker failures as project errors, not run failures", async () => {
    const { registryPath } = await fakeRegistry([{ name: "alpha", maxConcurrency: 1 }]);
    const fake = new FakeProjectOrchestrator([], new Error("fetch failed"));

    const result = await new RegistryOrchestrator({
      registryPath,
      createProjectOrchestrator: () => fake
    }).runOnce(false);

    expect(result.summaries[0]).toMatchObject({
      name: "alpha",
      status: "transient_tracker_error",
      errorCategory: "tracker_network",
      lastError: "fetch failed"
    });
  });

  it("skips a project already owned by another registry runner", async () => {
    const { registryPath, repos } = await fakeRegistry([{ name: "alpha", maxConcurrency: 1 }]);
    const lock = await acquireProjectRunnerLock(repos.alpha, "test-runner");
    const fake = new FakeProjectOrchestrator([1]);
    try {
      const result = await new RegistryOrchestrator({
        registryPath,
        createProjectOrchestrator: () => fake
      }).runOnce(false);

      expect(result.summaries[0]).toMatchObject({
        name: "alpha",
        status: "locked",
        errorCategory: "project_lock"
      });
      expect(fake.calls).toBe(0);
    } finally {
      await releaseProjectRunnerLock(lock);
    }
  });

  it("releases continuous registry locks when the daemon stops", async () => {
    const { registryPath, repos } = await fakeRegistry([{ name: "alpha", maxConcurrency: 1 }]);
    const controller = new AbortController();
    const lockPath = projectRunnerLockPath(repos.alpha);
    let lockHeldDuringRun = false;

    await new RegistryOrchestrator({
      registryPath,
      pollingIntervalMs: 1,
      createProjectOrchestrator: () =>
        new FakeProjectOrchestrator([0], undefined, async () => {
          lockHeldDuringRun = await pathExists(lockPath);
          controller.abort();
        })
    }).runUntilStopped(controller.signal);

    expect(lockHeldDuringRun).toBe(true);
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("rekeys held locks and cached orchestrators when registry project paths change", async () => {
    const { registryPath, repos, root } = await fakeRegistry([{ name: "alpha", maxConcurrency: 1 }]);
    const nextRepo = join(root, "alpha-next");
    await mkdir(nextRepo, { recursive: true });
    await writeWorkflow(nextRepo);
    const originalLockPath = projectRunnerLockPath(repos.alpha);
    const contexts: string[] = [];
    const controller = new AbortController();
    let originalLockReleasedBeforeNextRun = false;

    await new RegistryOrchestrator({
      registryPath,
      pollingIntervalMs: 1,
      createProjectOrchestrator: (context) => {
        contexts.push(context.repoRoot);
        return new FakeProjectOrchestrator([0], undefined, async () => {
          if (contexts.length === 1) {
            await writeRegistry(registryPath, [{ name: "alpha", repo: "./alpha-next", maxConcurrency: 1 }]);
          } else {
            originalLockReleasedBeforeNextRun = !(await pathExists(originalLockPath));
            controller.abort();
          }
        });
      }
    }).runUntilStopped(controller.signal);

    expect(contexts).toEqual([repos.alpha, nextRepo]);
    expect(originalLockReleasedBeforeNextRun).toBe(true);
    expect(await pathExists(projectRunnerLockPath(nextRepo))).toBe(false);
  });

  it("rejects invalid registry CLI throttle options instead of disabling caps", async () => {
    const { registryPath } = await fakeRegistry([]);

    await expect(execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "orchestrator", "once-registry", "--registry", registryPath, "--max-concurrency", "nope"])).rejects.toMatchObject({
      stderr: expect.stringContaining("max-concurrency must be a positive integer")
    });
    await expect(execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "orchestrator", "run-registry", "--registry", registryPath, "--poll-interval-ms", "NaN"])).rejects.toMatchObject({
      stderr: expect.stringContaining("poll-interval-ms must be a positive integer")
    });
  });

  it("makes single-project orchestrator commands honor the project-runner lock", async () => {
    const { repos } = await fakeRegistry([{ name: "alpha", maxConcurrency: 1 }]);
    const lock = await acquireProjectRunnerLock(repos.alpha, "test-runner");
    try {
      await expect(execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "orchestrator", "once", "--repo", repos.alpha])).rejects.toMatchObject({
        stderr: expect.stringContaining("project_registry_locked")
      });
    } finally {
      await releaseProjectRunnerLock(lock);
    }
  });
});

class FakeProjectOrchestrator implements ProjectOrchestrator {
  calls = 0;
  limits: number[] = [];

  constructor(
    private readonly dispatches: number[],
    private readonly error?: Error,
    private readonly onRun?: () => Promise<void> | void
  ) {}

  async runOnce(_waitForWorkers?: boolean, options?: { dispatchLimit?: number }): Promise<{ dispatched: number; candidates: number }> {
    this.calls += 1;
    const limit = options?.dispatchLimit ?? Number.POSITIVE_INFINITY;
    this.limits.push(Number.isFinite(limit) ? limit : -1);
    await this.onRun?.();
    if (this.error) throw this.error;
    const requested = this.dispatches.shift() ?? 0;
    const dispatched = Math.min(requested, limit);
    return { dispatched, candidates: requested };
  }
}

async function fakeRegistry(projects: Array<{ name: string; maxConcurrency: number }>): Promise<{ registryPath: string; repos: Record<string, string>; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "agent-os-registry-"));
  const repos: Record<string, string> = {};
  for (const project of projects) {
    const repo = join(root, project.name);
    repos[project.name] = repo;
    await mkdir(repo, { recursive: true });
    await writeWorkflow(repo);
  }
  const registryPath = join(root, "agent-os.yml");
  await writeRegistry(
    registryPath,
    projects.map((project) => ({ name: project.name, repo: `./${project.name}`, maxConcurrency: project.maxConcurrency }))
  );
  return { registryPath, repos, root };
}

async function writeWorkflow(repo: string): Promise<void> {
  await writeFile(
    join(repo, "WORKFLOW.md"),
    [
      "---",
      "tracker:",
      "  kind: linear",
      "  api_key: lin_test",
      "  project_slug: AgentOS",
      "agent:",
      "  max_concurrent_agents: 2",
      "workspace:",
      "  root: .agent-os/workspaces",
      "review:",
      "  enabled: false",
      "---",
      "Do work"
    ].join("\n"),
    "utf8"
  );
}

async function writeRegistry(registryPath: string, projects: Array<{ name: string; repo: string; maxConcurrency: number }>): Promise<void> {
  await writeFile(
    registryPath,
    [
      "version: 1",
      "defaults:",
      "  maxConcurrency: 2",
      "projects:",
      ...projects.flatMap((project) => [
        `  - name: ${project.name}`,
        `    repo: ${project.repo}`,
        "    workflow: WORKFLOW.md",
        `    maxConcurrency: ${project.maxConcurrency}`
      ])
    ].join("\n"),
    "utf8"
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function projectRunnerLockPath(repo: string): string {
  return join(repo, ".agent-os", "locks", "registry", "project-runner.lock");
}

function fakeIssue(id: string, identifier: string): Issue {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    priority: null,
    state: "In Progress",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
