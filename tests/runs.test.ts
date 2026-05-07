import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

  it("records optional phase timing fields in run summaries", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-timing-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });

    const phase = await store.startPhase(summary.runId, {
      phase: "implementation",
      label: "implementation turn 1",
      startedAt: "2026-05-01T00:00:00.000Z",
      metadata: { turnNumber: 1 }
    });
    await store.finishPhase(
      summary.runId,
      { id: phase.id },
      {
        finishedAt: "2026-05-01T00:00:01.500Z",
        metadata: { resultStatus: "succeeded" }
      }
    );

    const inspected = await store.inspect(summary.runId);
    expect(inspected.summary.timing?.phases).toEqual([
      expect.objectContaining({
        id: "implementation-1",
        phase: "implementation",
        label: "implementation turn 1",
        status: "completed",
        startedAt: "2026-05-01T00:00:00.000Z",
        finishedAt: "2026-05-01T00:00:01.500Z",
        durationMs: 1500,
        metadata: { turnNumber: 1, resultStatus: "succeeded" }
      })
    ]);
  });

  it("emits run events for synthetic stall and cancel timing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-stall-events-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });

    const completed = await store.completeRun(summary.runId, {
      status: "stalled",
      error: "stall timeout exceeded"
    });

    expect(completed.timing?.phases.find((phase) => phase.phase === "stall-cancel")).toEqual(
      expect.objectContaining({
        status: "stalled",
        metadata: { reason: "stall timeout exceeded" }
      })
    );
    const events = await store.replay(summary.runId);
    expect(events.some((event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "stall-cancel")).toBe(true);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "stall-cancel" && (event.payload as { timing?: { status?: string } }).timing?.status === "stalled")).toBe(true);
    expect((await store.inspect(summary.runId)).warnings).toEqual([]);
  });

  it("reads legacy summaries without phase timing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-legacy-"));
    const runId = "run_20260501000000_AG-1_legacy";
    await mkdir(join(repo, ".agent-os", "runs", runId), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "runs", runId, "summary.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          attempt: 1,
          status: "succeeded",
          startedAt: "2026-05-01T00:00:00.000Z",
          finishedAt: "2026-05-01T00:00:01.000Z",
          metrics: { tokens: {}, sessions: {}, rateLimits: [] },
          artifactHashes: {}
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const inspected = await new RunArtifactStore(repo).inspect(runId);
    expect(inspected.summary.timing).toBeUndefined();
    expect(formatRunInspect(inspected)).toContain("Status: succeeded");
    expect(await new RunArtifactStore(repo).listRuns()).toHaveLength(1);
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

  it("keeps terminal summaries terminal when event touches race with completion", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-race-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: null,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });

    await Promise.all([
      ...Array.from({ length: 50 }, (_, index) =>
        store.writeEvent(summary.runId, {
          type: "item/agentMessage/delta",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          timestamp: `2026-05-01T00:00:${String(index).padStart(2, "0")}.000Z`
        })
      ),
      store.completeRun(summary.runId, { status: "succeeded", threadId: "thread-1", turnId: "turn-1" })
    ]);

    const inspected = await store.inspect(summary.runId);
    expect(inspected.summary.status).toBe("succeeded");
    expect(inspected.summary.finishedAt).toBeTruthy();
  });
});
