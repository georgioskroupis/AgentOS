import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRunInspect, formatRunReplay, RunArtifactStore } from "../src/runs.js";
import type { RunPhaseTiming, RunSummary } from "../src/runs.js";
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

  it("summarizes healthy run cycle time", () => {
    const output = formatRunInspect({
      summary: runSummaryWithTiming("succeeded", "2026-05-01T00:08:00.000Z", [
        phase("implementation", "completed", "2026-05-01T00:00:00.000Z", "2026-05-01T00:05:00.000Z"),
        phase("validation", "completed", "2026-05-01T00:05:00.000Z", "2026-05-01T00:06:00.000Z"),
        phase("automated-review", "completed", "2026-05-01T00:06:00.000Z", "2026-05-01T00:08:00.000Z")
      ]),
      warnings: []
    });

    expect(output).toContain("Cycle time:");
    expect(output).toContain("- implementation: 5m (1 completed)");
    expect(output).toContain("- validation: 1m (1 completed)");
    expect(output).toContain("SLO diagnostics: healthy");
  });

  it("flags review-heavy run cycle time", () => {
    const output = formatRunInspect({
      summary: runSummaryWithTiming("succeeded", "2026-05-01T01:00:00.000Z", [
        phase("implementation", "completed", "2026-05-01T00:00:00.000Z", "2026-05-01T00:10:00.000Z"),
        phase("automated-review", "completed", "2026-05-01T00:10:00.000Z", "2026-05-01T00:30:00.000Z"),
        phase("fixer-turn", "completed", "2026-05-01T00:30:00.000Z", "2026-05-01T00:50:00.000Z"),
        phase("automated-review", "completed", "2026-05-01T00:50:00.000Z", "2026-05-01T01:00:00.000Z")
      ]),
      warnings: []
    });

    expect(output).toContain("long serial review time: 50m across 3 review/fix spans");
    expect(output).toContain("Next action: inspect review artifacts");
  });

  it("flags stall-heavy run cycle time", () => {
    const output = formatRunInspect({
      summary: runSummaryWithTiming("failed", "2026-05-01T00:40:00.000Z", [
        phase("implementation", "failed", "2026-05-01T00:00:00.000Z", "2026-05-01T00:05:00.000Z"),
        phase("stall-cancel", "stalled", "2026-05-01T00:05:00.000Z", "2026-05-01T00:25:00.000Z"),
        phase("retry-backoff", "completed", "2026-05-01T00:25:00.000Z", "2026-05-01T00:35:00.000Z")
      ]),
      warnings: []
    });

    expect(output).toContain("excessive stall/retry overhead: 30m");
    expect(output).toContain("Next action: inspect stall timeout");
  });

  it("keeps retry-backoff-only cycle time on the stall/retry path", () => {
    const output = formatRunInspect({
      summary: runSummaryWithTiming("failed", "2026-05-01T00:40:00.000Z", [
        phase("implementation", "failed", "2026-05-01T00:00:00.000Z", "2026-05-01T00:05:00.000Z"),
        phase("retry-backoff", "completed", "2026-05-01T00:05:00.000Z", "2026-05-01T00:40:00.000Z")
      ]),
      warnings: []
    });

    expect(output).toContain("- retry-backoff: 35m (1 completed)");
    expect(output).toContain("excessive stall/retry overhead: 35m");
    expect(output).toContain("Next action: inspect stall timeout");
    expect(output).not.toContain("merge/retry drift");
    expect(output).not.toContain("inspect selected PR checks");
  });

  it("flags human-wait run cycle time", () => {
    const output = formatRunInspect(
      {
        summary: runSummaryWithTiming("succeeded", "2026-05-01T00:02:00.000Z", [
          phase("implementation", "completed", "2026-05-01T00:00:00.000Z", "2026-05-01T00:02:00.000Z"),
          phase("human-wait", "waiting", "2026-05-01T00:02:00.000Z")
        ]),
        warnings: []
      },
      { now: "2026-05-01T05:02:00.000Z" }
    );

    expect(output).toContain("- human-wait: 5h (1 waiting, 1 open)");
    expect(output).toContain("long human-wait: 5h with an open wait");
    expect(output).toContain("Next action: check decision comments");
  });

  it("does not count closed human-wait time toward the open-wait SLO", () => {
    const output = formatRunInspect(
      {
        summary: runSummaryWithTiming("succeeded", undefined, [
          phase("human-wait", "completed", "2026-05-01T00:00:00.000Z", "2026-05-01T01:10:00.000Z"),
          phase("human-wait", "waiting", "2026-05-01T01:10:00.000Z")
        ]),
        warnings: []
      },
      { now: "2026-05-01T01:15:00.000Z" }
    );

    expect(output).toContain("- human-wait: 1h 15m (1 completed, 1 waiting, 1 open)");
    expect(output).toContain("SLO diagnostics: healthy");
    expect(output).not.toContain("long human-wait");
  });

  it("flags open human-wait when the open wait crosses its SLO", () => {
    const output = formatRunInspect(
      {
        summary: runSummaryWithTiming("succeeded", undefined, [phase("human-wait", "waiting", "2026-05-01T00:00:00.000Z")]),
        warnings: []
      },
      { now: "2026-05-01T01:05:00.000Z" }
    );

    expect(output).toContain("- human-wait: 1h 5m (1 waiting, 1 open)");
    expect(output).toContain("long human-wait: 1h 5m with an open wait");
  });

  it("flags merge and CI wait drift in run cycle time", () => {
    const output = formatRunInspect({
      summary: runSummaryWithTiming("failed", "2026-05-01T00:50:00.000Z", [
        phase("implementation", "completed", "2026-05-01T00:00:00.000Z", "2026-05-01T00:10:00.000Z"),
        phase("ci-wait", "failed", "2026-05-01T00:10:00.000Z", "2026-05-01T00:45:00.000Z")
      ]),
      warnings: []
    });

    expect(output).toContain("- ci-wait: 35m (1 failed)");
    expect(output).toContain("merge/retry drift: 35m spent in merge, CI wait, or retry backoff");
    expect(output).toContain("Next action: inspect selected PR checks and durable merge/retry state");
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

  it("emits run events for open phases finalized during completion", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-finalized-phase-events-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });

    await store.startPhase(summary.runId, {
      phase: "implementation",
      label: "implementation turn 1",
      startedAt: "2026-05-01T00:00:00.000Z",
      metadata: { turnNumber: 1 }
    });
    const completed = await store.markRunCanceled(summary.runId, "startup recovery canceled run");

    expect(completed.timing?.phases.find((phase) => phase.phase === "implementation")).toEqual(
      expect.objectContaining({
        status: "canceled",
        startedAt: "2026-05-01T00:00:00.000Z",
        finishedAt: expect.any(String),
        durationMs: expect.any(Number),
        metadata: { turnNumber: 1 }
      })
    );
    const events = await store.replay(summary.runId);
    expect(
      events.some(
        (event) =>
          event.type === "phase_finished" &&
          (event.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "implementation" &&
          (event.payload as { timing?: { status?: string } }).timing?.status === "canceled"
      )
    ).toBe(true);
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
    const output = formatRunInspect(inspected);
    expect(output).toContain("Status: succeeded");
    expect(output).toContain("Cycle time: no phase timing recorded");
    expect(output).toContain("SLO diagnostics: unavailable");
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

  it("bounds large event payloads with redacted artifact links", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-large-event-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });
    const secret = `lin_${"abcdefghijklmnopqrstuvwxyz123456"}`;

    await store.writeEvent(summary.runId, {
      type: "codex_stdout",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: "large command output",
      payload: {
        stdout: "line from command\n".repeat(800),
        token: secret
      },
      timestamp: "2026-05-01T00:00:00.000Z"
    });

    const logPath = join(repo, ".agent-os", "runs", summary.runId, "events.jsonl");
    const log = await readFile(logPath, "utf8");
    const entry = JSON.parse(log.trim()) as { payload: { agentOsCapture: { artifact?: string; kind: string } } };

    expect(log.trim().length).toBeLessThan(12_000);
    expect(entry.payload.agentOsCapture.kind).toBe("payload");
    expect(entry.payload.agentOsCapture.artifact).toBeTruthy();
    expect(log).not.toContain(secret);

    const artifactText = await readFile(join(repo, entry.payload.agentOsCapture.artifact!), "utf8");
    expect(artifactText).toContain("line from command");
    expect(artifactText).toContain("[REDACTED]");
    expect(artifactText).not.toContain(secret);
  });

  it("keeps binary-like event output valid and concise", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-binary-event-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });

    await store.writeEvent(summary.runId, {
      type: "codex_stdout",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: `bad chunk\u0000${"x".repeat(4_000)}`,
      timestamp: "2026-05-01T00:00:00.000Z"
    });

    const events = await store.replay(summary.runId);
    expect(events[0].message).toContain("binary-like output omitted");
    expect(formatRunReplay(summary.runId, events)).toContain("codex_stdout - [binary-like output omitted");
  });

  it("keeps malformed object payloads valid JSONL", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-circular-event-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });
    const circular: Record<string, unknown> = { output: "unterminated object shape" };
    circular.self = circular;

    await store.writeEvent(summary.runId, {
      type: "codex_stdout",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      payload: circular,
      timestamp: "2026-05-01T00:00:00.000Z"
    });

    const events = await store.replay(summary.runId);
    expect(events[0].payload).toMatchObject({ self: "[Circular]" });
  });

  it("continues reading legacy event logs with malformed trailing lines", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runs-legacy-events-"));
    const store = new RunArtifactStore(repo);
    const summary = await store.startRun({
      issue,
      attempt: 1,
      workspace: { path: join(repo, "workspace"), workspaceKey: "AG-1", createdNow: true }
    });
    await appendFile(
      join(repo, ".agent-os", "runs", summary.runId, "events.jsonl"),
      `${JSON.stringify({
        type: "legacy_unbounded_event",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: "legacy event without capture metadata",
        timestamp: "2026-05-01T00:00:00.000Z",
        payload: { output: "old shape" }
      })}\nnot json\n`,
      "utf8"
    );

    const events = await store.replay(summary.runId);
    expect(events.some((event) => event.type === "legacy_unbounded_event")).toBe(true);
    expect(events.some((event) => event.type === "event_log_parse_warning")).toBe(true);
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

function runSummaryWithTiming(status: RunSummary["status"], finishedAt: string | undefined, phases: RunPhaseTiming[]): RunSummary {
  return {
    schemaVersion: 1,
    runId: "run_20260501000000_AG-1_test",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt: 1,
    status,
    startedAt: "2026-05-01T00:00:00.000Z",
    ...(finishedAt ? { finishedAt } : {}),
    metrics: { tokens: {}, sessions: {}, rateLimits: [] },
    timing: {
      updatedAt: finishedAt ?? "2026-05-01T00:00:00.000Z",
      phases
    },
    artifactHashes: {}
  };
}

function phase(phaseName: RunPhaseTiming["phase"], status: RunPhaseTiming["status"], startedAt: string, finishedAt?: string): RunPhaseTiming {
  return {
    id: `${phaseName}-test-${startedAt}`,
    phase: phaseName,
    status,
    startedAt,
    ...(finishedAt ? { finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(startedAt) } : {})
  };
}
