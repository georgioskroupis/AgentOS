import { describe, expect, it } from "vitest";
import { monitorSnapshotStatuses, monitorUiSections, NullMonitorSink, type LauncherConfig, type MonitorEvent, type MonitorSnapshot } from "../src/index.js";

describe("monitor contracts", () => {
  it("exposes a no-op source-core-safe sink for monitor events", async () => {
    const sink = new NullMonitorSink();
    const event: MonitorEvent = {
      eventId: "event-1",
      spanId: "span-1",
      runId: "run-1",
      timestamp: "2026-05-25T00:00:00.000Z",
      kind: "run_started",
      label: "Run started",
      status: "active",
      timeClass: "agent"
    };

    await expect(Promise.resolve(sink.emit(event))).resolves.toBeUndefined();
  });

  it("fixes the lean monitor UI sections and snapshot statuses", () => {
    expect(monitorUiSections).toEqual(["Run Header", "Tiny Summary", "Current Activity", "Nested Timing Table", "Top Time Sinks", "Human Action", "Links"]);
    expect(monitorSnapshotStatuses).toEqual(["idle", "active", "waiting", "human_action", "failed", "completed"]);
  });

  it("keeps extension-only snapshot and launcher shapes type-checkable", () => {
    const config: LauncherConfig = {
      repo: "/repo",
      workflow: "WORKFLOW.md",
      port: 4317,
      host: "127.0.0.1"
    };
    const snapshot: MonitorSnapshot = {
      serverNow: "2026-05-25T00:00:01.000Z",
      status: "active",
      run: {
        issue: { id: "VER-150", title: "Define monitor contract", linearStatus: "In Progress" },
        attempt: { current: 0 },
        runElapsedMs: 1000,
        links: { linear: "https://linear.app/veritystudio/issue/VER-150" },
        summary: { why: "Define contract", build: "Contracts only", done: "No runtime movement" },
        currentActivity: { stage: "audit", step: "inventory", stepElapsedMs: 500, lastEventAgeMs: 10 },
        timing: [
          {
            id: "span-1",
            label: "Audit",
            status: "active",
            timeClass: "agent",
            startedAt: "2026-05-25T00:00:00.000Z",
            durationMs: 1000,
            selfMs: 1000,
            waitMs: 0,
            children: []
          }
        ],
        topTimeSinks: [{ id: "span-1", label: "Audit", selfMs: 1000, timeClass: "agent" }],
        humanAction: {
          required: false,
          stoppedBecause: "Not needed",
          youShould: "Not needed",
          manualTest: "Not needed",
          expectedResult: "Not needed",
          recommendedNextStep: "Not needed"
        }
      }
    };

    expect(config.host).toBe("127.0.0.1");
    expect(snapshot.run?.humanAction.required).toBe(false);
  });
});
