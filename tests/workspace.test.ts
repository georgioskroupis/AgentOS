import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireWorkspaceLock, releaseWorkspaceLock, WorkspaceManager, workspaceKey } from "../src/workspace.js";
import type { ServiceConfig } from "../src/types.js";

describe("workspace", () => {
  it("sanitizes keys", () => {
    expect(workspaceKey("AG 1/hello")).toBe("AG_1_hello");
  });

  it("runs after-create hooks with workspace env", async () => {
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
        afterCreate: 'mkdir -p "$AGENT_OS_WORKSPACE" && printf "$AGENT_OS_WORKSPACE_KEY" > "$AGENT_OS_WORKSPACE/key.txt"',
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
      codex: {
        command: "codex app-server",
        approvalEventPolicy: "deny",
        userInputPolicy: "deny",
        turnTimeoutMs: 1000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 1000,
        passThrough: {}
      },
      github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
      review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"] }
    };

    const manager = new WorkspaceManager(config, source);
    const workspace = await manager.createOrReuse("AG-1");
    expect(await readFile(join(workspace.path, "key.txt"), "utf8")).toBe("AG-1");
    expect(workspace.lockPath).toBeTruthy();
    await expect(stat(workspace.lockPath!)).resolves.toBeTruthy();
    await manager.afterRun(workspace);
    await expect(stat(workspace.lockPath!)).rejects.toThrow();
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
        AGENT_OS_WORKSPACE_KEY: "AG-1"
      },
      false
    );

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("dirty source worktree");
  });
});

function serviceConfig(root: string): ServiceConfig {
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
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 5000 },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 20,
      maxRetryAttempts: 3,
      maxRetryBackoffMs: 1000,
      maxConcurrentAgentsByState: new Map()
    },
    codex: {
      command: "codex app-server",
      approvalEventPolicy: "deny",
      userInputPolicy: "deny",
      turnTimeoutMs: 1000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 1000,
      passThrough: {}
    },
    github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
    review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"] }
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
