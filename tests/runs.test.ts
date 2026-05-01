import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRunInspect, formatRunReplay, RunArtifactStore } from "../src/runs.js";
import type { Issue } from "../src/types.js";

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Run artifact issue",
  description: null,
  priority: 1,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null
};

describe("run artifacts", () => {
  it("writes schema-versioned summaries with artifact hashes and metrics", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });

    await store.writePrompt(summary.runId, "Prompt");
    await store.writeEvent(summary.runId, {
      type: "turn/completed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      timestamp: "2026-05-01T00:00:00.000Z"
    });
    await store.writeHandoff(summary.runId, "AgentOS-Outcome: implemented");
    const completed = await store.completeRun(summary.runId, {
      status: "succeeded",
      threadId: "thread-1",
      turnId: "turn-1",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      rateLimits: [{ limitId: "codex" }]
    });

    expect(completed).toMatchObject({
      schemaVersion: 1,
      runId: summary.runId,
      status: "succeeded",
      metrics: {
        tokens: { input: 10, output: 5, total: 15 },
        sessions: { threadId: "thread-1", turnId: "turn-1" },
        rateLimits: [{ limitId: "codex" }]
      }
    });
    expect(Object.keys(completed.artifactHashes).sort()).toEqual(["events.jsonl", "handoff.md", "prompt.md"]);
    const inspected = formatRunInspect(await store.inspect(summary.runId));
    expect(inspected).toContain("Rate limits: 1 snapshot recorded");
    expect(inspected).toContain("Warnings: none");

    await appendFile(join(repo, ".agent-os", "runs", summary.runId, "prompt.md"), "\ntampered", "utf8");
    expect(formatRunInspect(await store.inspect(summary.runId))).toContain("artifact hash mismatch: prompt.md");
  });

  it("simulates and replays local-only fake runs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-sim-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.simulateRun({ issueIdentifier: "SIM-1" });

    expect(summary).toMatchObject({
      schemaVersion: 1,
      issueIdentifier: "SIM-1",
      status: "succeeded"
    });
    const replay = formatRunReplay(summary.runId, await store.replay(summary.runId));
    expect(replay).toContain("simulation_started - local simulation");
    expect(replay).toContain("run_succeeded - simulation complete");
  });
});
