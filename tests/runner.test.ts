import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CodexAppServerRunner, verifyCodexAppServer } from "../src/runner/app-server.js";
import type { Issue, ServiceConfig, Workspace } from "../src/types.js";

const execFileAsync = promisify(execFile);
const fixture = resolve("tests/fixtures/fake-app-server.mjs");
const fixtureCommand = `node ${JSON.stringify(fixture)}`;
const instantFixtureCommand = `node ${JSON.stringify(fixture)} --instant`;
const strictSandboxFixtureCommand = `node ${JSON.stringify(fixture)} --strict-sandbox`;
const gitWritableRootsFixtureCommand = `node ${JSON.stringify(fixture)} --strict-sandbox --require-git-writable-roots`;
const approvalRequestFixtureCommand = `node ${JSON.stringify(fixture)} --approval-request`;
const inputRequestFixtureCommand = `node ${JSON.stringify(fixture)} --input-request`;
const elicitationRequestFixtureCommand = `node ${JSON.stringify(fixture)} --elicitation-request`;
const prScriptFailureFixtureCommand = `node ${JSON.stringify(fixture)} --pr-script-failure`;
const nestedOrchestratorFixtureCommand = `node ${JSON.stringify(fixture)} --nested-orchestrator`;
const exitBeforeCompletionFixtureCommand = `node ${JSON.stringify(fixture)} --exit-before-completion`;

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Runner issue",
  description: null,
  priority: 1,
  state: "Ready",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null
};

describe("CodexAppServerRunner", () => {
  it("verifies app server support", async () => {
    await expect(verifyCodexAppServer(fixtureCommand)).resolves.toMatchObject({ ok: true });
  });

  it("runs a thread and waits for turn completion", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
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
      workspace: { root: workspacePath },
      hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
      agent: { maxConcurrentAgents: 1, maxTurns: 20, maxRetryAttempts: 3, maxRetryBackoffMs: 1000, maxConcurrentAgentsByState: new Map() },
      codex: {
        command: fixtureCommand,
        approvalPolicy: "never",
        approvalEventPolicy: "deny",
        userInputPolicy: "deny",
        threadSandbox: "workspace-write",
        turnTimeoutMs: 5000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 5000,
        passThrough: {}
      },
      github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
      review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"] }
    };

    const events: string[] = [];
    const runner = new CodexAppServerRunner();
    const result = await runner.run({
      issue,
      prompt: "Do work",
      attempt: null,
      workspace,
      config,
      onEvent(event) {
        events.push(event.type);
      }
    });
    expect(result).toMatchObject({
      status: "succeeded",
      threadId: "thread-1",
      turnId: "turn-1",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      rateLimits: [{ limitId: "codex", primary: { usedPercent: 1 } }]
    });
    expect(events).toContain("turn/completed");
    expect(events).toContain("thread/tokenUsage/updated");
    expect(events).toContain("account/rateLimits/updated");
  });

  it("handles completion events that arrive before the waiter is registered", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-instant-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
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
      workspace: { root: workspacePath },
      hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
      agent: { maxConcurrentAgents: 1, maxTurns: 20, maxRetryAttempts: 3, maxRetryBackoffMs: 1000, maxConcurrentAgentsByState: new Map() },
      codex: {
        command: instantFixtureCommand,
        approvalPolicy: "never",
        approvalEventPolicy: "deny",
        userInputPolicy: "deny",
        threadSandbox: "workspaceWrite",
        turnTimeoutMs: 5000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 5000,
        passThrough: {}
      },
      github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
      review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"] }
    };

    const runner = new CodexAppServerRunner();
    await expect(
      runner.run({
        issue,
        prompt: "Do quick work",
        attempt: null,
        workspace,
        config,
        onEvent() {}
      })
    ).resolves.toMatchObject({ status: "succeeded", threadId: "thread-1", turnId: "turn-1" });
  });

  it("uses app-server sandbox names expected by thread and turn start", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-sandbox-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
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
      workspace: { root: workspacePath },
      hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
      agent: { maxConcurrentAgents: 1, maxTurns: 20, maxRetryAttempts: 3, maxRetryBackoffMs: 1000, maxConcurrentAgentsByState: new Map() },
      codex: {
        command: strictSandboxFixtureCommand,
        approvalEventPolicy: "deny",
        userInputPolicy: "deny",
        turnTimeoutMs: 5000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 5000,
        passThrough: {}
      },
      github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
      review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"] }
    };

    const runner = new CodexAppServerRunner();
    await expect(
      runner.run({
        issue,
        prompt: "Do sandboxed work",
        attempt: null,
        workspace,
        config,
        onEvent() {}
      })
    ).resolves.toMatchObject({ status: "succeeded", threadId: "thread-1", turnId: "turn-1" });
  });

  it("adds git worktree metadata dirs to default writable roots", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runner-git-repo-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-os-runner-git-worktrees-"));
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "agentos@example.test"]);
    await git(repo, ["config", "user.name", "AgentOS Test"]);
    await writeFile(join(repo, "README.md"), "AgentOS test repo\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    const workspacePath = join(workspaceRoot, "AG-1");
    await git(repo, ["worktree", "add", "-b", "agent/AG-1", workspacePath, "HEAD"]);
    const gitDir = await gitOutput(workspacePath, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const gitCommonDir = await gitOutput(workspacePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
    const config = runnerConfig(workspacePath, gitWritableRootsFixtureCommand);
    const previousEnv = {
      workspace: process.env.AGENT_OS_EXPECTED_WORKSPACE_ROOT,
      gitDir: process.env.AGENT_OS_EXPECTED_GIT_DIR,
      gitCommonDir: process.env.AGENT_OS_EXPECTED_GIT_COMMON_DIR
    };

    process.env.AGENT_OS_EXPECTED_WORKSPACE_ROOT = workspacePath;
    process.env.AGENT_OS_EXPECTED_GIT_DIR = gitDir;
    process.env.AGENT_OS_EXPECTED_GIT_COMMON_DIR = gitCommonDir;
    try {
      await expect(
        new CodexAppServerRunner().run({
          issue,
          prompt: "Do git worktree work",
          attempt: null,
          workspace,
          config,
          onEvent() {}
        })
      ).resolves.toMatchObject({ status: "succeeded", threadId: "thread-1", turnId: "turn-1" });
    } finally {
      restoreEnv("AGENT_OS_EXPECTED_WORKSPACE_ROOT", previousEnv.workspace);
      restoreEnv("AGENT_OS_EXPECTED_GIT_DIR", previousEnv.gitDir);
      restoreEnv("AGENT_OS_EXPECTED_GIT_COMMON_DIR", previousEnv.gitCommonDir);
    }
  });

  it("denies approval request events by default", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-approval-policy-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
    const config = runnerConfig(workspacePath, approvalRequestFixtureCommand);
    const events: Array<{ type: string; message?: string }> = [];

    await expect(
      new CodexAppServerRunner().run({
        issue,
        prompt: "Do policy work",
        attempt: null,
        workspace,
        config,
        onEvent(event) {
          events.push({ type: event.type, message: event.message });
        }
      })
    ).resolves.toMatchObject({ status: "failed", error: "codex_approval_request_denied" });
    expect(events).toContainEqual({ type: "codex_event_policy_denied", message: "codex_approval_request_denied" });
  });

  it("denies user input request events by default", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-input-policy-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
    const config = runnerConfig(workspacePath, inputRequestFixtureCommand);

    await expect(
      new CodexAppServerRunner().run({
        issue,
        prompt: "Do policy work",
        attempt: null,
        workspace,
        config,
        onEvent() {}
      })
    ).resolves.toMatchObject({ status: "failed", error: "codex_user_input_request_denied" });
  });

  it("denies MCP elicitation request events by default", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-elicitation-policy-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
    const config = runnerConfig(workspacePath, elicitationRequestFixtureCommand);
    const events: Array<{ type: string; message?: string; payload?: unknown }> = [];

    await expect(
      new CodexAppServerRunner().run({
        issue,
        prompt: "Do policy work",
        attempt: null,
        workspace,
        config,
        onEvent(event) {
          events.push({ type: event.type, message: event.message, payload: event.payload });
        }
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: "codex_elicitation_request_denied",
      threadId: "thread-1",
      turnId: "turn-1"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "codex_event_policy_denied",
        message: "codex_elicitation_request_denied",
        payload: expect.objectContaining({
          method: "mcpServer/elicitation/request",
          policy: "user_input_denied"
        })
      })
    );
  });

  it("stops failed deterministic PR creation commands without falling back to interaction", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-pr-failure-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
    const config = runnerConfig(workspacePath, prScriptFailureFixtureCommand);
    const events: Array<{ type: string; message?: string; payload?: unknown }> = [];

    await expect(
      new CodexAppServerRunner().run({
        issue,
        prompt: "Open a PR",
        attempt: null,
        workspace,
        config,
        onEvent(event) {
          events.push({ type: event.type, message: event.message, payload: event.payload });
        }
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: "agent_pr_creation_failed",
      threadId: "thread-1",
      turnId: "turn-1"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "codex_command_stop",
        message: "agent_pr_creation_failed",
        payload: expect.objectContaining({
          command: expect.stringContaining("scripts/agent-create-pr.sh"),
          exitCode: 1
        })
      })
    );
  });

  it("fails promptly when the app server exits before turn completion", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-app-server-exit-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
    const config = runnerConfig(workspacePath, exitBeforeCompletionFixtureCommand);

    await expect(
      new CodexAppServerRunner().run({
        issue,
        prompt: "Do work before exiting",
        attempt: null,
        workspace,
        config,
        onEvent() {}
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: "codex_app_server_closed: exit 42",
      threadId: "thread-1",
      turnId: "turn-1"
    });
  });

  it("stops nested orchestrator commands inside agent turns", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "agent-os-runner-nested-orchestrator-"));
    const workspace: Workspace = { path: workspacePath, workspaceKey: "AG-1", createdNow: true };
    const config = runnerConfig(workspacePath, nestedOrchestratorFixtureCommand);
    const events: Array<{ type: string; message?: string; payload?: unknown }> = [];

    await expect(
      new CodexAppServerRunner().run({
        issue,
        prompt: "Do not start another scheduler",
        attempt: null,
        workspace,
        config,
        onEvent(event) {
          events.push({ type: event.type, message: event.message, payload: event.payload });
        }
      })
    ).resolves.toMatchObject({
      status: "failed",
      error: "nested_orchestrator_forbidden",
      threadId: "thread-1",
      turnId: "turn-1"
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "codex_command_stop",
        message: "nested_orchestrator_forbidden",
        payload: expect.objectContaining({
          command: expect.stringContaining("agent-os orchestrator once")
        })
      })
    );
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function runnerConfig(workspacePath: string, command: string): ServiceConfig {
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
    workspace: { root: workspacePath },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 20, maxRetryAttempts: 3, maxRetryBackoffMs: 1000, maxConcurrentAgentsByState: new Map() },
    codex: {
      command,
      approvalPolicy: "never",
      approvalEventPolicy: "deny",
      userInputPolicy: "deny",
      threadSandbox: "workspace-write",
      turnTimeoutMs: 5000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 5000,
      passThrough: {}
    },
    github: { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
    review: { enabled: true, maxIterations: 3, requiredReviewers: ["self", "correctness", "tests", "architecture"], optionalReviewers: ["security"], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"] }
  };
}
