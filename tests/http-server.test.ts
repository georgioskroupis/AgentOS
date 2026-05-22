import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentOsApiState, startAgentOsHttpServer, type AgentOsHttpServerHandle } from "../src/http-server.js";
import { IssueStateStore } from "../src/issue-state.js";
import { RunArtifactStore } from "../src/runs.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { fakeIssue } from "./fixtures/agentos-fakes.js";

const handles: AgentOsHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("AgentOS HTTP API", () => {
  it("is disabled without an explicit port", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-disabled-"));
    await expect(startAgentOsHttpServer({ repoRoot: repo })).resolves.toBeNull();
  });

  it("serves runtime state, issue detail, and token/rate-limit summaries", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-state-"));
    const issue = fakeIssue({ identifier: "VER-96" });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "review",
      updatedAt: "2026-05-22T00:00:00.000Z"
    });
    await new RuntimeStateStore(repo).upsertActiveRun({
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt: null,
      runId: "run-1",
      startedAt: "2026-05-22T00:00:00.000Z",
      phase: "streaming-turn",
      workspacePath: "/tmp/workspace"
    });
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: "retry-1",
      identifier: "VER-97",
      issue: fakeIssue({ id: "retry-1", identifier: "VER-97" }),
      attempt: 2,
      dueAt: "2026-05-22T00:05:00.000Z",
      error: "offline",
      scheduledAt: "2026-05-22T00:01:00.000Z"
    });
    const runStore = new RunArtifactStore(repo);
    const run = await runStore.startRun({ issue, attempt: null });
    await runStore.completeRun(run.runId, {
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      rateLimits: [{ limitId: "codex", primary: { usedPercent: 10 } }]
    });

    const state = await buildAgentOsApiState(repo, new Date("2026-05-22T00:10:00.000Z"));
    expect(state.running).toMatchObject([{ identifier: "VER-96", phase: "streaming-turn" }]);
    expect(state.retrying).toMatchObject([{ identifier: "VER-97", attempt: 2 }]);
    expect(state.codex_totals).toEqual({ runs: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(state.rate_limits).toEqual([{ limitId: "codex", primary: { usedPercent: 10 } }]);

    const server = await startAgentOsHttpServer({ repoRoot: repo, port: 0 });
    expect(server).not.toBeNull();
    handles.push(server!);

    await expect(fetch(`${server!.url}/api/v1/state`).then((response) => response.json())).resolves.toMatchObject({
      running: [{ identifier: "VER-96" }],
      retrying: [{ identifier: "VER-97" }]
    });
    await expect(fetch(`${server!.url}/api/v1/VER-96`).then((response) => response.json())).resolves.toMatchObject({
      issue: { issueIdentifier: "VER-96" },
      activeRun: { identifier: "VER-96" }
    });
    const missing = await fetch(`${server!.url}/api/v1/NOPE`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("coalesces refresh requests and reports unsupported methods", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-refresh-"));
    let refreshes = 0;
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });
    const server = await startAgentOsHttpServer({
      repoRoot: repo,
      port: 0,
      onRefresh: async () => {
        refreshes += 1;
        await refreshPromise;
      }
    });
    expect(server).not.toBeNull();
    handles.push(server!);

    const first = fetch(`${server!.url}/api/v1/refresh`, { method: "POST" }).then((response) => response.json());
    const second = fetch(`${server!.url}/api/v1/refresh`, { method: "POST" }).then((response) => response.json());
    await expect(first).resolves.toMatchObject({ queued: true, coalesced: false, operations: ["poll", "reconcile"] });
    await expect(second).resolves.toMatchObject({ queued: true, coalesced: true, operations: ["poll", "reconcile"] });
    expect(refreshes).toBe(1);
    resolveRefresh();

    const method = await fetch(`${server!.url}/api/v1/state`, { method: "POST" });
    expect(method.status).toBe(405);
    await expect(method.json()).resolves.toMatchObject({ success: false, error: { code: "method_not_allowed" } });
  });
});
