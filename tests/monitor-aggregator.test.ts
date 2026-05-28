import { describe, expect, it } from "vitest";
import { buildMonitorActivity, InMemoryMonitorAggregator, monitorActivityKinds, type MonitorActivityKind, type MonitorEvent, type MonitorRunContext } from "../src/index.js";

const runContext: MonitorRunContext = {
  runId: "run-1",
  issue: { id: "VER-153", title: "Add monitor reducer", url: "https://linear.app/veritystudio/issue/VER-153", linearStatus: "In Progress" },
  attempt: { current: 0, max: 3 },
  links: { linear: "https://linear.app/veritystudio/issue/VER-153" },
  summary: { why: "Implement monitor reducer", build: "Aggregator tests", done: "Reducer is active" }
};

describe("in-memory monitor aggregator", () => {
  it("computes nested duration, self time, wait time, and top sinks from self time", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext(runContext);

    emitAll(aggregator, [
      event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z"),
      event("stage", "stage_started", "Parent stage", "2026-05-25T00:00:01.000Z", { parentSpanId: "run" }),
      event("wait", "wait_started", "CI wait", "2026-05-25T00:00:02.000Z", { parentSpanId: "stage", timeClass: "external-wait" }),
      event("wait", "wait_finished", "CI wait", "2026-05-25T00:00:05.000Z"),
      event("step", "step_started", "Focused work", "2026-05-25T00:00:06.000Z", { parentSpanId: "stage" }),
      event("step", "step_finished", "Focused work", "2026-05-25T00:00:16.000Z"),
      event("stage", "stage_finished", "Parent stage", "2026-05-25T00:00:20.000Z")
    ]);

    const snapshot = aggregator.snapshot({ serverNow: "2026-05-25T00:00:30.000Z", topTimeSinkLimit: 4 });
    const run = snapshot.run;
    const stage = run?.timing[0]?.children[0];

    expect(snapshot.status).toBe("active");
    expect(run?.runElapsedMs).toBe(30000);
    expect(stage).toMatchObject({
      id: "stage",
      durationMs: 19000,
      selfMs: 6000,
      waitMs: 3000
    });
    expect(stage?.children.map((child) => [child.id, child.durationMs, child.selfMs, child.waitMs])).toEqual([
      ["wait", 3000, 3000, 3000],
      ["step", 10000, 10000, 0]
    ]);
    expect(run?.topTimeSinks.map((sink) => sink.id)).toEqual(["run", "step", "stage", "wait"]);
  });

  it("keeps finished rows immutable while active rows derive duration from serverNow", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext(runContext);
    emitAll(aggregator, [
      event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z"),
      event("step", "step_started", "Finished step", "2026-05-25T00:00:00.000Z", { parentSpanId: "run" }),
      event("step", "step_finished", "Finished step", "2026-05-25T00:00:05.000Z")
    ]);

    const early = aggregator.snapshot({ serverNow: "2026-05-25T00:00:10.000Z" });
    const late = aggregator.snapshot({ serverNow: "2026-05-25T00:00:20.000Z" });

    expect(early.run?.timing[0]?.durationMs).toBe(10000);
    expect(late.run?.timing[0]?.durationMs).toBe(20000);
    expect(early.run?.timing[0]?.children[0]?.durationMs).toBe(5000);
    expect(late.run?.timing[0]?.children[0]?.durationMs).toBe(5000);
  });

  it("renders sanitized command execution activity as timing rows under the active step", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext(runContext);
    emitAll(aggregator, [
      event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z"),
      event("turn", "step_started", "implementation turn 1", "2026-05-25T00:00:01.000Z", { parentSpanId: "run" }),
      event("cmd-active", "step_started", "Command: npm run active", "2026-05-25T00:00:02.000Z", {
        parentSpanId: "turn",
        status: "active",
        timeClass: "tool",
        result: "running"
      }),
      event("cmd-pass", "step_started", "Command: npm run pass", "2026-05-25T00:00:03.000Z", { parentSpanId: "turn", timeClass: "tool" }),
      event("cmd-pass", "step_finished", "Command: npm run pass", "2026-05-25T00:00:05.000Z", {
        status: "pass",
        timeClass: "tool",
        result: "exit 0"
      }),
      event("cmd-fail", "step_started", "Command: npm run fail", "2026-05-25T00:00:06.000Z", { parentSpanId: "turn", timeClass: "tool" }),
      event("cmd-fail", "step_finished", "Command: npm run fail", "2026-05-25T00:00:10.000Z", {
        status: "failed",
        timeClass: "tool",
        result: "exit 2"
      })
    ]);

    const turn = aggregator.snapshot({ serverNow: "2026-05-25T00:00:12.000Z" }).run?.timing[0]?.children[0];

    expect(turn?.children.map((child) => [child.id, child.label, child.status, child.durationMs, child.result])).toEqual([
      ["cmd-active", "Command: npm run active", "active", 10000, "running"],
      ["cmd-pass", "Command: npm run pass", "pass", 2000, "exit 0"],
      ["cmd-fail", "Command: npm run fail", "failed", 4000, "exit 2"]
    ]);
    expect(JSON.stringify(turn)).not.toContain("stdout");
    expect(JSON.stringify(turn)).not.toContain("stderr");
  });

  it.each(monitorActivityKinds)("shows %s as the last meaningful low-level activity without changing scheduler status", (kind) => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext(runContext);
    emitAll(aggregator, [
      event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z"),
      event("turn", "step_started", "implementation turn 1", "2026-05-25T00:00:01.000Z", { parentSpanId: "run" }),
      event("turn", "activity_observed", "Low-level activity", "2026-05-25T00:00:03.000Z", {
        parentSpanId: "run",
        activity: activityForKind(kind)
      })
    ]);

    const snapshot = aggregator.snapshot({ serverNow: "2026-05-25T00:00:10.000Z" });

    expect(snapshot.status).toBe("active");
    expect(snapshot.run?.currentActivity.lastMeaningfulActivity).toEqual({
      kind,
      label: activityForKind(kind).label,
      ageMs: 7000,
      observedAt: "2026-05-25T00:00:03.000Z"
    });
  });

  it("keeps missing low-level activity unavailable instead of treating freshness as a stale failure", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext(runContext);
    emitAll(aggregator, [
      event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z"),
      event("turn", "step_started", "implementation turn 1", "2026-05-25T00:00:01.000Z", { parentSpanId: "run" })
    ]);

    const snapshot = aggregator.snapshot({ serverNow: "2026-05-25T00:10:00.000Z" });

    expect(snapshot.status).toBe("active");
    expect(snapshot.run?.currentActivity.lastEventAgeMs).toBe(599000);
    expect(snapshot.run?.currentActivity.lastMeaningfulActivity).toBeUndefined();
  });

  it("closes active rows on terminal events and retains only active run plus terminal snapshot", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext(runContext);
    emitAll(aggregator, [
      event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z"),
      event("stage", "stage_started", "Active stage", "2026-05-25T00:00:02.000Z", { parentSpanId: "run" }),
      event("run", "run_failed", "Run failed", "2026-05-25T00:00:08.000Z", { result: "Validation failed" })
    ]);

    expect(aggregator.retention()).toEqual({ activeEventCount: 0, hasTerminalSnapshot: true });

    const terminal = aggregator.snapshot({ serverNow: "2026-05-25T00:00:30.000Z" });
    expect(terminal.status).toBe("failed");
    expect(terminal.serverNow).toBe("2026-05-25T00:00:08.000Z");
    expect(terminal.run?.timing[0]).toMatchObject({ id: "run", endedAt: "2026-05-25T00:00:08.000Z", durationMs: 8000 });
    expect(terminal.run?.timing[0]?.children[0]).toMatchObject({ id: "stage", endedAt: "2026-05-25T00:00:08.000Z", durationMs: 6000 });

    aggregator.updateRunContext({ ...runContext, runId: "run-2" });
    aggregator.emit(event("run-2:run", "run_started", "Second run", "2026-05-25T00:01:00.000Z", { runId: "run-2" }));

    expect(aggregator.retention()).toEqual({ activeRunId: "run-2", activeEventCount: 1, hasTerminalSnapshot: true });
  });

  it("processes events by timestamp, ties by insertion order, and closes matching span ids only", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext(runContext);
    emitAll(aggregator, [
      event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z"),
      event("child-a", "step_started", "Child A", "2026-05-25T00:00:02.000Z", { parentSpanId: "stage" }),
      event("stage", "stage_started", "Stage", "2026-05-25T00:00:01.000Z", { parentSpanId: "run" }),
      event("child-b", "step_started", "Child B", "2026-05-25T00:00:02.000Z", { parentSpanId: "stage" }),
      event("wrong-id", "step_finished", "Wrong finish", "2026-05-25T00:00:03.000Z"),
      event("child-a", "step_finished", "Child A", "2026-05-25T00:00:04.000Z"),
      event("child-b", "step_finished", "Child B", "2026-05-25T00:00:05.000Z")
    ]);

    const snapshot = aggregator.snapshot({ serverNow: "2026-05-25T00:00:10.000Z" });
    const run = snapshot.run?.timing[0];
    const stage = run?.children[0];

    expect(run?.id).toBe("run");
    expect(stage?.id).toBe("stage");
    expect(stage?.children.map((child) => child.id)).toEqual(["child-a", "child-b"]);
    expect(stage?.children.map((child) => child.durationMs)).toEqual([2000, 3000]);
  });

  it("generates deterministic summary lines without using supplied prose as source of truth", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext({
      ...runContext,
      summary: { why: "caller supplied why", build: "caller supplied build", done: "caller supplied done" },
      changedFiles: ["docs/quality/TEST_SUITE.md"]
    });
    emitAll(aggregator, [event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z")]);

    const summary = aggregator.snapshot({ serverNow: "2026-05-25T00:00:05.000Z" }).run?.summary;

    expect(Object.keys(summary ?? {})).toEqual(["why", "build", "done"]);
    expect(summary).toEqual({
      why: "Work on VER-153: Add monitor reducer",
      build: "Docs-only changes are in scope.",
      done: "Current step: Run"
    });
  });

  it("derives required human action from reason code and changed surface rules", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext({
      ...runContext,
      humanAction: {
        reasonCode: "architecture_check_failed",
        changedFiles: ["scripts/check-architecture.mjs"]
      }
    });
    emitAll(aggregator, [event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z")]);

    const snapshot = aggregator.snapshot({ serverNow: "2026-05-25T00:00:05.000Z" });

    expect(snapshot.status).toBe("human_action");
    expect(snapshot.run?.humanAction).toEqual({
      required: true,
      stoppedBecause: "Stopped because the architecture check needs attention.",
      youShould: "Inspect the architecture check output and the affected boundary.",
      manualTest: "Run npm run check:architecture.",
      expectedResult: "Architecture validation passes or reports only accepted findings.",
      recommendedNextStep: "Align the architecture boundary or update the contract, then rerun the architecture check."
    });
  });

  it("surfaces pre-dispatch planning pauses as human-action wait snapshots", () => {
    const aggregator = new InMemoryMonitorAggregator();
    emitAll(aggregator, [
      event("pre_dispatch_VER-164:run", "run_started", "Preserve PR and validation metadata", "2026-05-25T00:00:00.000Z", {
        runId: "pre_dispatch_VER-164",
        issueId: "VER-164"
      }),
      event("pre_dispatch_VER-164:needs-input", "wait_started", "Planning/decomposition required", "2026-05-25T00:00:00.000Z", {
        runId: "pre_dispatch_VER-164",
        issueId: "VER-164",
        parentSpanId: "pre_dispatch_VER-164:run",
        status: "waiting",
        timeClass: "human-wait"
      }),
      event("pre_dispatch_VER-164:human-action", "human_action_required", "Planning/decomposition required", "2026-05-25T00:00:00.000Z", {
        runId: "pre_dispatch_VER-164",
        issueId: "VER-164",
        humanAction: {
          reasonCode: "planning_required",
          details: "likely-large scope needs planning or decomposition before implementation dispatch"
        }
      })
    ]);

    const snapshot = aggregator.snapshot({ serverNow: "2026-05-25T00:00:05.000Z" });

    expect(snapshot.status).toBe("human_action");
    expect(snapshot.run?.issue.id).toBe("VER-164");
    expect(snapshot.run?.currentActivity).toMatchObject({
      stage: "Preserve PR and validation metadata",
      step: "Planning/decomposition required",
      stepElapsedMs: 5000
    });
    expect(snapshot.run?.humanAction).toMatchObject({
      required: true,
      stoppedBecause: "likely-large scope needs planning or decomposition before implementation dispatch",
      recommendedNextStep: "Add a bounded Active Scope or split follow-up issues, then return the issue to an active state."
    });
  });

  it.each([
    ["docs-only", ["docs/product/README.md"], "Manual test could not be inferred from docs-only changes.", "Docs accurately describe the implemented behavior."],
    ["workflow/config", ["WORKFLOW.md"], "Run the affected workflow/config check or inspect the policy path manually.", "Workflow/config behavior matches the intended policy."],
    ["UI", ["dashboard/index.html"], "Open the monitor UI and verify the changed view renders correctly.", "The monitor UI renders the changed state without layout or data regressions."]
  ])("covers %s human-action changed-surface wording", (_label, changedFiles, manualTest, expectedResult) => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext({
      ...runContext,
      humanAction: {
        reasonCode: "needs_input",
        changedFiles
      }
    });
    emitAll(aggregator, [event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z")]);

    const action = aggregator.snapshot({ serverNow: "2026-05-25T00:00:05.000Z" }).run?.humanAction;

    expect(action?.manualTest).toBe(manualTest);
    expect(action?.expectedResult).toBe(expectedResult);
  });

  it("keeps human action present and compact when no action is needed", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext({ ...runContext, changedFiles: ["src/monitor-aggregator.ts"] });
    emitAll(aggregator, [event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z")]);

    expect(aggregator.snapshot({ serverNow: "2026-05-25T00:00:05.000Z" }).run?.humanAction).toEqual({
      required: false,
      stoppedBecause: "Not needed",
      youShould: "Not needed",
      manualTest: "Not needed",
      expectedResult: "Not needed",
      recommendedNextStep: "Not needed"
    });
  });

  it("invalidates generated text when changed surfaces change during the run", () => {
    const aggregator = new InMemoryMonitorAggregator();
    aggregator.updateRunContext({ ...runContext, changedFiles: ["docs/README.md"] });
    emitAll(aggregator, [event("run", "run_started", "Run", "2026-05-25T00:00:00.000Z")]);

    const docs = aggregator.snapshot({ serverNow: "2026-05-25T00:00:05.000Z" }).run?.summary.build;
    aggregator.updateRunContext({ ...runContext, changedFiles: ["dashboard/index.html"] });
    const ui = aggregator.snapshot({ serverNow: "2026-05-25T00:00:06.000Z" }).run?.summary.build;

    expect(docs).toBe("Docs-only changes are in scope.");
    expect(ui).toBe("UI behavior is in scope.");
  });
});

function emitAll(aggregator: InMemoryMonitorAggregator, events: MonitorEvent[]): void {
  for (const monitorEvent of events) aggregator.emit(monitorEvent);
}

function activityForKind(kind: MonitorActivityKind): MonitorEvent["activity"] {
  if (kind === "command_output") return buildMonitorActivity({ kind, label: "Runner stdout observed", stream: "stdout", bytesObserved: 128 });
  if (kind === "file_change") return buildMonitorActivity({ kind, label: "File-change metadata observed", changedFileCount: 2, lastFile: "src/monitor-aggregator.ts", category: "source" });
  if (kind === "token_usage") return buildMonitorActivity({ kind, label: "Token update observed", inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  if (kind === "rate_limit") return buildMonitorActivity({ kind, label: "Rate-limit update observed", pressure: "medium", resetAt: "2026-05-25T00:05:00.000Z" });
  return buildMonitorActivity({ kind, label: "Generic activity observed" });
}

function event(
  spanId: string,
  kind: MonitorEvent["kind"],
  label: string,
  timestamp: string,
  options: Partial<Omit<MonitorEvent, "eventId" | "spanId" | "kind" | "label" | "timestamp">> = {}
): MonitorEvent {
  return {
    eventId: `${spanId}:${kind}:${timestamp}`,
    spanId,
    runId: "run-1",
    timestamp,
    kind,
    label,
    status: kind.endsWith("_started") ? "active" : kind === "run_failed" ? "failed" : "done",
    timeClass: "agent",
    ...options
  };
}
