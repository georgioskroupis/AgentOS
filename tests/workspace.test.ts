import { mkdir, mkdtemp, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWorkspaceLock, releaseWorkspaceLock, WorkspaceManager, workspaceBootstrapHookHash, workspaceBootstrapMarkerPath, workspaceKey } from "../src/workspace.js";
import type { ServiceConfig } from "../src/types.js";

const defaultReviewBudget: ServiceConfig["review"]["budget"] = {
  enabled: true,
  mode: "recommend-only",
  maxReviewElapsedMs: 30 * 60 * 1000,
  maxReviewIterations: 3,
  maxFixerIterations: 2,
  maxBlockingFindings: 10,
  maxP1P2Findings: 5,
  maxChangedFiles: 40,
  maxValidationReruns: 2,
  maxReviewTokens: 200_000,
  repeatedBroadCategoryThreshold: 2,
  lateNewBlockingFindingAfterApproval: true,
  broadCategories: ["architecture", "lifecycle", "orchestration", "status", "workflow"]
};

describe("workspace", () => {
  it("sanitizes keys", () => {
    expect(workspaceKey("AG 1/hello")).toBe("AG_1_hello");
  });

  it("runs after-create hooks from an already-created absolute workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-"));
    const config: ServiceConfig = {
      trustMode: "ci-locked",
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "x",
        projectSlug: "AgentOS",
        activeStates: ["Ready"],
        terminalStates: ["Done"],
        runningState: "In Progress",
        reviewState: "Human Review",
        mergeState: null,
        needsInputState: "Human Review"
      },
      polling: { intervalMs: 1000 },
      workspace: { root },
      hooks: {
        afterCreate: [
          'test -d "$AGENT_OS_WORKSPACE"',
          'test "$(pwd -P)" = "$(cd "$AGENT_OS_WORKSPACE" && pwd -P)"',
          'case "$AGENT_OS_WORKSPACE" in /*) ;; *) exit 12 ;; esac',
          'case "$AGENT_OS_SOURCE_REPO" in /*) ;; *) exit 13 ;; esac',
          'printf "$AGENT_OS_WORKSPACE_KEY" > key.txt',
          'pwd -P > pwd.txt',
          'printf "$AGENT_OS_WORKSPACE" > env-workspace.txt'
        ].join(" && "),
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5000
      },
      agent: {
        maxConcurrentAgents: 1,
        maxTurns: 20,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 1000,
        maxConcurrentAgentsByState: new Map()
      },
      contextBudget: { enabled: true, maxPromptTokens: 200_000, maxCumulativeTokens: 1_000_000, largeSectionTokens: 8_000 },
      validationBudget: { enabled: true, fullValidationCommand: "npm run agent-check", maxFullValidationRunsPerHead: 1 },
      codex: {
        command: "codex app-server",
        approvalEventPolicy: "deny",
        userInputPolicy: "deny",
        turnTimeoutMs: 1000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 1000,
        passThrough: {}
      },
      github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false, baseBranch: "main" },
      daemon: { mainBranchRefreshIntervalTicks: 5 },
      review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"], parallelReviewers: false, maxConcurrentReviewers: 1, skipOptionalReviewersAfterBlockingRequired: false, budget: defaultReviewBudget }
    };

    const manager = new WorkspaceManager(config, source);
    const workspace = await manager.createOrReuse("AG-1");
    expect(isAbsolute(workspace.path)).toBe(true);
    expect(await readFile(join(workspace.path, "key.txt"), "utf8")).toBe("AG-1");
    expect(await readFile(join(workspace.path, "pwd.txt"), "utf8")).toBe(`${await realpath(workspace.path)}\n`);
    expect(await readFile(join(workspace.path, "env-workspace.txt"), "utf8")).toBe(workspace.path);
    const marker = JSON.parse(await readFile(workspaceBootstrapMarkerPath(source, "AG-1"), "utf8")) as Record<string, unknown>;
    expect(marker).toMatchObject({
      schemaVersion: 1,
      workspaceKey: "AG-1",
      workspacePath: workspace.path,
      workspaceRoot: resolve(root),
      sourceRepo: resolve(source),
      hookCommandHash: workspaceBootstrapHookHash(config.hooks.afterCreate),
      hookTimeoutMs: 5000
    });
    expect(marker).not.toHaveProperty("hookCommand");
    expect(workspace.lockPath).toBeTruthy();
    await expect(stat(workspace.lockPath!)).resolves.toBeTruthy();
    await manager.afterRun(workspace);
    await expect(stat(workspace.lockPath!)).rejects.toThrow();
  });

  it("reuses successfully initialized workspaces without rerunning after-create", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-reuse-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-reuse-"));
    const config = serviceConfig(root, {
      afterCreate: 'count="$AGENT_OS_SOURCE_REPO/count.txt"; current="$(cat "$count" 2>/dev/null || printf 0)"; printf "%s" "$((current + 1))" > "$count"; printf initialized > marker.txt'
    });
    const manager = new WorkspaceManager(config, source);

    const first = await manager.createOrReuse("AG-1");
    await manager.afterRun(first);
    const second = await manager.createOrReuse("AG-1");

    expect(second.createdNow).toBe(false);
    expect(await readFile(join(source, "count.txt"), "utf8")).toBe("1");
    await manager.afterRun(second);
  });

  it("does not mark failed after-create attempts and releases the lock for retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-fail-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-fail-"));
    const manager = new WorkspaceManager(serviceConfig(root, { afterCreate: "printf partial > partial.txt && exit 9" }), source);

    await expect(manager.createOrReuse("AG-1")).rejects.toThrow("hook_failed exit=9");
    await expect(stat(workspaceBootstrapMarkerPath(source, "AG-1"))).rejects.toThrow();
    const retryLock = await acquireWorkspaceLock(root, "AG-1", join(root, "AG-1"));
    await releaseWorkspaceLock(retryLock);
  });

  it("reruns bootstrap for empty partial workspaces and refuses non-empty partial workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-partial-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-partial-"));
    await mkdir(join(root, "AG-1"), { recursive: true });
    const emptyRetry = await new WorkspaceManager(serviceConfig(root, { afterCreate: "printf bootstrapped > boot.txt" }), source).createOrReuse("AG-1");
    expect(await readFile(join(emptyRetry.path, "boot.txt"), "utf8")).toBe("bootstrapped");
    await new WorkspaceManager(serviceConfig(root), source).afterRun(emptyRetry);

    await mkdir(join(root, "AG-2"), { recursive: true });
    await writeFile(join(root, "AG-2", "leftover.txt"), "partial", "utf8");
    await expect(new WorkspaceManager(serviceConfig(root, { afterCreate: "printf ignored > ignored.txt" }), source).createOrReuse("AG-2")).rejects.toThrow(
      "workspace_partial_bootstrap"
    );
  });

  it("recreates stale-marker workspaces and refuses unsafe marker mismatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-marker-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-marker-"));
    const markerPath = workspaceBootstrapMarkerPath(source, "AG-1");
    await mkdir(resolve(markerPath, ".."), { recursive: true });
    await writeFile(
      markerPath,
      JSON.stringify({
        schemaVersion: 1,
        workspaceKey: "AG-1",
        workspacePath: join(root, "AG-1"),
        workspaceRoot: resolve(root),
        sourceRepo: resolve(source),
        hookCommandHash: workspaceBootstrapHookHash("printf stale > stale.txt"),
        hookTimeoutMs: 5000,
        initializedAt: new Date().toISOString()
      }),
      "utf8"
    );
    const recreated = await new WorkspaceManager(serviceConfig(root, { afterCreate: "printf recreated > recreated.txt" }), source).createOrReuse("AG-1");
    expect(await readFile(join(recreated.path, "recreated.txt"), "utf8")).toBe("recreated");
    await new WorkspaceManager(serviceConfig(root), source).afterRun(recreated);

    const mismatch = await new WorkspaceManager(serviceConfig(root, { afterCreate: "printf one > one.txt" }), source).createOrReuse("AG-2");
    await new WorkspaceManager(serviceConfig(root), source).afterRun(mismatch);
    await expect(new WorkspaceManager(serviceConfig(root, { afterCreate: "printf two > two.txt" }), source).createOrReuse("AG-2")).rejects.toThrow(
      "workspace_partial_bootstrap"
    );
  });

  it("records initialization markers when no after-create hook is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-no-hook-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-no-hook-"));

    const workspace = await new WorkspaceManager(serviceConfig(root), source).createOrReuse("AG-1");
    const marker = JSON.parse(await readFile(workspaceBootstrapMarkerPath(source, "AG-1"), "utf8")) as Record<string, unknown>;

    expect(marker.hookCommandHash).toBe(workspaceBootstrapHookHash(null));
    await new WorkspaceManager(serviceConfig(root), source).afterRun(workspace);
  });

  it("records no-hook markers for existing non-empty workspaces", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-no-hook-existing-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-no-hook-existing-"));
    await mkdir(join(root, "AG-1"), { recursive: true });
    await writeFile(join(root, "AG-1", "existing.txt"), "safe no-hook workspace", "utf8");

    const workspace = await new WorkspaceManager(serviceConfig(root), source).createOrReuse("AG-1");
    const marker = JSON.parse(await readFile(workspaceBootstrapMarkerPath(source, "AG-1"), "utf8")) as Record<string, unknown>;

    expect(workspace.createdNow).toBe(false);
    expect(marker.hookCommandHash).toBe(workspaceBootstrapHookHash(null));
    await new WorkspaceManager(serviceConfig(root), source).afterRun(workspace);
  });

  it("runs before-run, after-run, and before-remove hooks from the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-lifecycle-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-lifecycle-"));
    const config = serviceConfig(root, {
      beforeRun: 'pwd -P > before-run-pwd.txt && printf "$AGENT_OS_WORKSPACE" > before-run-env.txt',
      afterRun: 'pwd -P > after-run-pwd.txt',
      beforeRemove: 'pwd -P > "$AGENT_OS_SOURCE_REPO/before-remove-pwd.txt" && exit 7'
    });
    const manager = new WorkspaceManager(config, source);
    const workspace = await manager.createOrReuse("AG-1");

    await manager.beforeRun(workspace);
    await manager.afterRun(workspace);
    expect(await readFile(join(workspace.path, "before-run-pwd.txt"), "utf8")).toBe(`${await realpath(workspace.path)}\n`);
    expect(await readFile(join(workspace.path, "before-run-env.txt"), "utf8")).toBe(workspace.path);
    expect(await readFile(join(workspace.path, "after-run-pwd.txt"), "utf8")).toBe(`${await realpath(workspace.path)}\n`);

    const realWorkspacePath = await realpath(workspace.path);
    await manager.remove("AG-1");
    expect(await readFile(join(source, "before-remove-pwd.txt"), "utf8")).toBe(`${realWorkspacePath}\n`);
    await expect(stat(workspace.path)).rejects.toThrow();
    await expect(stat(workspaceBootstrapMarkerPath(source, "AG-1"))).rejects.toThrow();
  });

  it("runs the default bootstrap script from the pre-created workspace", async () => {
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-bootstrap-"));
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-bootstrap-"));
    await run("git", ["init"], source);
    await run("git", ["config", "user.email", "agentos@example.test"], source);
    await run("git", ["config", "user.name", "AgentOS Test"], source);
    await writeFile(join(source, "README.md"), "test\n", "utf8");
    await run("git", ["add", "README.md"], source);
    await run("git", ["commit", "-m", "initial"], source);
    const script = resolve("scripts/agent-bootstrap-worktree.sh");
    const config = serviceConfig(root, { afterCreate: `bash ${JSON.stringify(script)}` });

    const workspace = await new WorkspaceManager(config, source).createOrReuse("AG-1");

    expect(await readFile(join(workspace.path, "README.md"), "utf8")).toBe("test\n");
    expect(await readdir(workspace.path)).toContain(".git");
    await new WorkspaceManager(serviceConfig(root), source).afterRun(workspace);
    await run("git", ["worktree", "remove", "--force", workspace.path], source);
  });

  it("refuses a workspace with a live lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-lock-live-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-lock-live-"));
    const config = serviceConfig(root);
    const lockPath = await acquireWorkspaceLock(root, "AG-1", join(root, "AG-1"));

    await expect(new WorkspaceManager(config, source).createOrReuse("AG-1")).rejects.toThrow("workspace_locked: AG-1");
    await releaseWorkspaceLock(lockPath);
  });

  it("recovers a stale workspace lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-lock-stale-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-lock-stale-"));
    const key = "AG-1";
    const lockPath = join(root, ".agent-os", "locks", "workspaces", `${key}.lock`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        workspaceKey: key,
        workspacePath: join(root, key),
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z"
      }),
      "utf8"
    );

    const workspace = await new WorkspaceManager(serviceConfig(root), source).createOrReuse(key);
    expect(workspace.lockPath).toBe(lockPath);
    await releaseWorkspaceLock(lockPath);
  });

  it("refuses to bootstrap a worktree from a dirty source repo", async () => {
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-dirty-"));
    const workspace = join(await mkdtemp(join(tmpdir(), "agent-os-ws-dirty-")), "AG-1");
    await run("git", ["init"], source);
    await run("sh", ["-lc", "printf dirty > file.txt"], source);

    const result = await run(
      "bash",
      [resolve("scripts/agent-bootstrap-worktree.sh")],
      source,
      {
        AGENT_OS_SOURCE_REPO: source,
        AGENT_OS_WORKSPACE: workspace,
        AGENT_OS_WORKSPACE_KEY: "AG-1",
        AGENT_OS_ALLOW_DIRTY_WORKTREE: ""
      },
      false
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("dirty source worktree");
  });
});

function serviceConfig(root: string, hooks: Partial<ServiceConfig["hooks"]> = {}): ServiceConfig {
  return {
    trustMode: "ci-locked",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "x",
      projectSlug: "AgentOS",
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: "In Progress",
      reviewState: "Human Review",
      mergeState: null,
      needsInputState: "Human Review"
    },
    polling: { intervalMs: 1000 },
    workspace: { root },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 5000, ...hooks },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 20,
      maxRetryAttempts: 3,
      maxRetryBackoffMs: 1000,
      maxConcurrentAgentsByState: new Map()
    },
    contextBudget: { enabled: true, maxPromptTokens: 200_000, maxCumulativeTokens: 1_000_000, largeSectionTokens: 8_000 },
    validationBudget: { enabled: true, fullValidationCommand: "npm run agent-check", maxFullValidationRunsPerHead: 1 },
    codex: {
      command: "codex app-server",
      approvalEventPolicy: "deny",
      userInputPolicy: "deny",
      turnTimeoutMs: 1000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 1000,
      passThrough: {}
    },
    github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false, baseBranch: "main" },
    daemon: { mainBranchRefreshIntervalTicks: 5 },
    review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"], parallelReviewers: false, maxConcurrentReviewers: 1, skipOptionalReviewersAfterBlockingRequired: false, budget: defaultReviewBudget }
  };
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  rejectOnFailure = true
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (rejectOnFailure && code !== 0) reject(new Error(stderr || `${command} failed`));
      else resolvePromise(result);
    });
  });
}
