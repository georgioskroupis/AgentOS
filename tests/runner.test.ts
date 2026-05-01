import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerRunner, verifyCodexAppServer } from "../src/runner/app-server.js";
import type { Issue, ServiceConfig, Workspace } from "../src/types.js";

const fixture = resolve("tests/fixtures/fake-app-server.mjs");
const fixtureCommand = `node ${JSON.stringify(fixture)}`;
const instantFixtureCommand = `node ${JSON.stringify(fixture)} --instant`;
const strictSandboxFixtureCommand = `node ${JSON.stringify(fixture)} --strict-sandbox`;
const approvalRequestFixtureCommand = `node ${JSON.stringify(fixture)} --approval-request`;
const inputRequestFixtureCommand = `node ${JSON.stringify(fixture)} --input-request`;

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
});

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
