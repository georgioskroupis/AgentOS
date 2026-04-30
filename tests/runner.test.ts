import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerRunner, verifyCodexAppServer } from "../src/runner/app-server.js";
import type { Issue, ServiceConfig, Workspace } from "../src/types.js";

const fixture = resolve("tests/fixtures/fake-app-server.mjs");
const fixtureCommand = `node ${JSON.stringify(fixture)}`;

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
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "x",
        projectSlug: "AgentOS",
        activeStates: ["Ready"],
        terminalStates: ["Done"]
      },
      polling: { intervalMs: 1000 },
      workspace: { root: workspacePath },
      hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
      agent: { maxConcurrentAgents: 1, maxTurns: 20, maxRetryBackoffMs: 1000, maxConcurrentAgentsByState: new Map() },
      codex: {
        command: fixtureCommand,
        approvalPolicy: "never",
        threadSandbox: "workspace-write",
        turnTimeoutMs: 5000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 5000,
        passThrough: {}
      }
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
    expect(result).toMatchObject({ status: "succeeded", threadId: "thread-1", turnId: "turn-1" });
    expect(events).toContain("turn/completed");
  });
});
