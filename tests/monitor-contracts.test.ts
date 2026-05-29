import { describe, expect, it } from "vitest";
import { buildMonitorActivity, monitorActivityKinds, monitorSnapshotStatuses, monitorUiSections, NullMonitorSink, type LauncherConfig, type MonitorEvent, type MonitorSnapshot } from "../src/index.js";

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
    expect(monitorActivityKinds).toEqual(["command_output", "file_change", "token_usage", "rate_limit", "generic"]);
    expect(monitorUiSections).toEqual(["Run Header", "Tiny Summary", "Current Activity", "Nested Timing Table", "Top Time Sinks", "Human Action", "Links"]);
    expect(monitorSnapshotStatuses).toEqual(["idle", "active", "waiting", "human_action", "failed", "completed"]);
  });

  it("supports compact activity_observed monitor events", () => {
    const event: MonitorEvent = {
      eventId: "activity-1",
      spanId: "span-1",
      runId: "run-1",
      timestamp: "2026-05-25T00:00:00.000Z",
      kind: "activity_observed",
      label: "Command output observed",
      activity: buildMonitorActivity({
        kind: "command_output",
        label: "Command output observed",
        command: "npm test",
        stream: "stdout",
        bytesObserved: 2048
      })
    };

    expect(event.activity).toEqual({
      kind: "command_output",
      label: "Command output observed",
      command: "npm test",
      stream: "stdout",
      bytesObserved: 2048
    });
  });

  it("builds each monitor activity kind from compact fields only", () => {
    expect(buildMonitorActivity({ kind: "file_change", label: "Source files changed", changedFileCount: 1, lastFile: "src/monitor-contracts.ts", category: "source" })).toEqual({
      kind: "file_change",
      label: "Source files changed",
      changedFileCount: 1,
      lastFile: "src/monitor-contracts.ts",
      category: "source"
    });
    expect(buildMonitorActivity({ kind: "token_usage", label: "Thread token usage", inputTokens: 10, outputTokens: 20, totalTokens: 30 })).toEqual({
      kind: "token_usage",
      label: "Thread token usage",
      totalTokens: 30,
      inputTokens: 10,
      outputTokens: 20
    });
    expect(buildMonitorActivity({ kind: "rate_limit", label: "Rate-limit pressure", pressure: "high", resetAt: "2026-05-25T00:01:00.000Z" })).toEqual({
      kind: "rate_limit",
      label: "Rate-limit pressure",
      pressure: "high",
      resetAt: "2026-05-25T00:01:00.000Z"
    });
    expect(buildMonitorActivity({ kind: "generic", label: "Runner tool call observed", category: "runner", name: "tool-call", count: 2 })).toEqual({
      kind: "generic",
      label: "Runner tool call observed"
    });
  });

  it("drops runtime-like raw payloads from monitor activity", () => {
    const previous = process.env.AGENTOS_MONITOR_TEST_SECRET;
    process.env.AGENTOS_MONITOR_TEST_SECRET = "monitor-secret-value";
    try {
      const activity = buildMonitorActivity({
        kind: "command_output",
        label: "compact note with monitor-secret-value redacted",
        command: "npm test && echo monitor-secret-value",
        stream: "stderr",
        bytesObserved: 400,
        lineCount: 4,
        byteCount: 500,
        exitCode: 0,
        truncated: true,
        metadata: {
          safeCount: 3,
          note: "compact note with monitor-secret-value redacted"
        },
        stdout: "raw stdout should not be emitted",
        stderr: "raw stderr should not be emitted",
        output: "raw output should not be emitted",
        diff: "+secret diff should not be emitted",
        patch: "-secret patch should not be emitted",
        prompt: "raw prompt should not be emitted",
        modelText: "raw model response should not be emitted",
        rawRateLimitPayload: { reset: "raw payload should not be emitted" }
      });
      const serialized = JSON.stringify(activity);

      expect(activity).toEqual({
        kind: "command_output",
        label: "compact note with [REDACTED] redacted",
        command: "npm test && echo [REDACTED]",
        stream: "stderr",
        bytesObserved: 400
      });
      expect(serialized).not.toContain("raw stdout");
      expect(serialized).not.toContain("raw stderr");
      expect(serialized).not.toContain("secret diff");
      expect(serialized).not.toContain("secret patch");
      expect(serialized).not.toContain("raw prompt");
      expect(serialized).not.toContain("raw model response");
      expect(serialized).not.toContain("raw payload");
      expect(serialized).not.toContain("monitor-secret-value");
    } finally {
      if (previous == null) delete process.env.AGENTOS_MONITOR_TEST_SECRET;
      else process.env.AGENTOS_MONITOR_TEST_SECRET = previous;
    }
  });

  it("keeps rate-limit and file-change activity narrow", () => {
    expect(
      buildMonitorActivity({
        kind: "rate_limit",
        label: "OpenAI rate pressure",
        pressure: "blocked",
        resetAt: "2026-05-25T00:01:00.000Z",
        limit: 100,
        remaining: 0,
        retryAfterMs: 60000,
        rawRateLimitPayload: { remaining: 0, reset: "raw" }
      })
    ).toEqual({
      kind: "rate_limit",
      label: "OpenAI rate pressure",
      pressure: "blocked",
      resetAt: "2026-05-25T00:01:00.000Z"
    });

    expect(buildMonitorActivity({ kind: "file_change", label: "Absolute file dropped", changedFileCount: 1, lastFile: "/Users/example/repo/src/private.ts", category: "source" })).toEqual({
      kind: "file_change",
      label: "Absolute file dropped",
      changedFileCount: 1,
      category: "source"
    });
  });

  it("normalizes safe file activity paths and redacts user-specific or raw diff paths", () => {
    expect(buildMonitorActivity({ kind: "file_change", label: "Repo absolute path", changedFileCount: 2, lastFile: `${process.cwd()}/src/monitor-contracts.ts` })).toEqual({
      kind: "file_change",
      label: "Repo absolute path",
      changedFileCount: 2,
      lastFile: "src/monitor-contracts.ts",
      category: "source"
    });
    expect(buildMonitorActivity({ kind: "file_change", label: "Docs path", path: "docs/product/README.md" })).toEqual({
      kind: "file_change",
      label: "Docs path",
      lastFile: "docs/product/README.md",
      category: "docs"
    });
    expect(buildMonitorActivity({ kind: "file_change", label: "Config path", path: "WORKFLOW.md" })).toEqual({
      kind: "file_change",
      label: "Config path",
      lastFile: "WORKFLOW.md",
      category: "config"
    });
    expect(buildMonitorActivity({ kind: "file_change", label: "Raw diff ignored", changedFileCount: 1, path: "diff --git a/src/private.ts b/src/private.ts\n+secret" })).toEqual({
      kind: "file_change",
      label: "Raw diff ignored",
      changedFileCount: 1,
      category: "unknown"
    });
    expect(buildMonitorActivity({ kind: "file_change", label: "Home prefix ignored", changedFileCount: 1, path: "~/repo/src/private.ts" })).toEqual({
      kind: "file_change",
      label: "Home prefix ignored",
      changedFileCount: 1,
      category: "unknown"
    });
    expect(buildMonitorActivity({ kind: "file_change", label: "Temp prefix ignored", changedFileCount: 1, path: "/tmp/agent-os/private.ts" })).toEqual({
      kind: "file_change",
      label: "Temp prefix ignored",
      changedFileCount: 1,
      category: "unknown"
    });
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
        runId: "run-150",
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
