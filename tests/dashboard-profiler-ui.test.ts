import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type ProfilerApi = {
  renderSnapshot(snapshot: Record<string, unknown>, options?: Record<string, unknown>): string;
  setStandaloneMode(enabled: boolean, launcherState?: Record<string, unknown>): void;
};

type LoadProfilerOptions = {
  launcherApi?: Record<string, unknown>;
};

describe("dashboard live profiler UI", () => {
  it("renders idle browser mode with exactly seven sections and disabled link placeholders", () => {
    const { profiler } = loadProfiler();
    const html = profiler.renderSnapshot({ serverNow: "2026-05-26T00:00:00.000Z", status: "idle" });

    expect(sectionNames(html)).toEqual(["Run Header", "Tiny Summary", "Current Activity", "Nested Timing Table", "Top Time Sinks", "Human Action", "Links"]);
    expect(html).toContain("AgentOS Monitor");
    expect(html).toContain("Not needed");
    expect(linkLabels(html)).toEqual(["Linear", "PR", "Handoff", "Validation"]);
    expect((html.match(/aria-disabled="true"/g) ?? []).length).toBe(4);
    expect(html).not.toContain("<button");
  });

  it("renders active durations from serverNow and rounds milliseconds to seconds", () => {
    const { profiler } = loadProfiler();
    const html = profiler.renderSnapshot(activeSnapshot(), { serverNow: "2026-05-26T00:00:15.000Z" });

    expect(html).toContain("Active");
    expect(html).toContain('data-row-id="run"');
    expect(html).toContain('data-ms="15000"');
    expect(html).toContain(">15s<");
  });

  it("renders waiting state without browser mutation controls", () => {
    const { profiler } = loadProfiler();
    const snapshot = activeSnapshot("waiting");
    const html = profiler.renderSnapshot(snapshot, { serverNow: "2026-05-26T00:00:12.000Z" });

    expect(html).toContain("Waiting");
    expect(html).toContain("external-wait");
    expect(html).not.toContain("<button");
    expect(linkLabels(html)).toEqual(["Linear", "PR", "Handoff", "Validation"]);
  });

  it("does not double-count server-provided wait time for finished parent rows", () => {
    const { profiler } = loadProfiler();
    const html = profiler.renderSnapshot(nestedWaitSnapshot(), { serverNow: "2026-05-26T00:00:10.000Z" });

    expect(rowHtml(html, "parent")).toContain('data-ms="4000"');
    expect(rowHtml(html, "parent")).not.toContain('data-ms="8000"');
    expect(rowHtml(html, "wait")).toContain('data-ms="4000"');
  });

  it("renders command timing rows with compact results without exposing raw output", () => {
    const { profiler } = loadProfiler();
    const html = profiler.renderSnapshot(commandRowsSnapshot(), { serverNow: "2026-05-26T00:00:12.000Z" });

    expect(rowHtml(html, "cmd-active")).toContain("Command: npm run active");
    expect(rowHtml(html, "cmd-active")).toContain(">active<");
    expect(rowHtml(html, "cmd-active")).toContain(">running<");
    expect(rowHtml(html, "cmd-active")).toContain('data-ms="10000"');
    expect(rowHtml(html, "cmd-pass")).toContain(">pass<");
    expect(rowHtml(html, "cmd-pass")).toContain(">exit 0<");
    expect(rowHtml(html, "cmd-fail")).toContain(">failed<");
    expect(rowHtml(html, "cmd-fail")).toContain(">exit 2<");
    expect(html).not.toContain("raw stdout");
    expect(html).not.toContain("raw stderr");
  });

  it("renders low-level activity freshness when present and unavailable when missing", () => {
    const { profiler } = loadProfiler();
    const withActivity = activeSnapshot();
    const run = withActivity.run as Record<string, unknown>;
    run.currentActivity = {
      stage: "implementation",
      step: "render UI",
      stepElapsedMs: 4000,
      lastEventAgeMs: 1000,
      lastMeaningfulActivity: {
        kind: "token_usage",
        label: "Runner token usage observed",
        ageMs: 3000,
        observedAt: "2026-05-26T00:00:07.000Z",
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15
        }
      }
    };

    const freshHtml = profiler.renderSnapshot(withActivity, { serverNow: "2026-05-26T00:00:12.000Z" });
    const unavailableHtml = profiler.renderSnapshot(activeSnapshot(), { serverNow: "2026-05-26T00:00:12.000Z" });

    expect(freshHtml).toContain("Last low-level activity");
    expect(freshHtml).toContain("Token update");
    expect(freshHtml).toContain("Low-level activity age");
    expect(freshHtml).toContain('data-ms="5000"');
    expect(freshHtml).toContain("Thread tokens");
    expect(freshHtml).toContain(">15<");
    expect(freshHtml).toContain("Input tokens");
    expect(freshHtml).toContain(">10<");
    expect(freshHtml).toContain("Output tokens");
    expect(freshHtml).toContain(">5<");
    expect(unavailableHtml).toContain("Unavailable");
  });

  it("renders ambiguous token data as unavailable and rate-limit data as compact pressure only", () => {
    const { profiler } = loadProfiler();
    const tokenSnapshot = activeSnapshot();
    const tokenRun = tokenSnapshot.run as Record<string, unknown>;
    tokenRun.currentActivity = {
      stage: "implementation",
      step: "render UI",
      stepElapsedMs: 4000,
      lastEventAgeMs: 1000,
      lastMeaningfulActivity: {
        kind: "token_usage",
        label: "Runner token usage observed",
        ageMs: 3000,
        observedAt: "2026-05-26T00:00:07.000Z",
        tokenUsage: {}
      }
    };

    const rateSnapshot = activeSnapshot();
    const rateRun = rateSnapshot.run as Record<string, unknown>;
    rateRun.currentActivity = {
      stage: "implementation",
      step: "render UI",
      stepElapsedMs: 4000,
      lastEventAgeMs: 1000,
      lastMeaningfulActivity: {
        kind: "rate_limit",
        label: "Runner rate-limit pressure observed",
        ageMs: 3000,
        observedAt: "2026-05-26T00:00:07.000Z",
        rateLimit: {
          pressure: "high",
          resetAt: "2026-05-26T00:05:00.000Z",
          rawRateLimitPayload: { remaining: 0 }
        }
      }
    };

    const tokenHtml = profiler.renderSnapshot(tokenSnapshot, { serverNow: "2026-05-26T00:00:12.000Z" });
    const rateHtml = profiler.renderSnapshot(rateSnapshot, { serverNow: "2026-05-26T00:00:12.000Z" });

    expect(tokenHtml).toContain("Thread tokens");
    expect((tokenHtml.match(/Unavailable/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(rateHtml).toContain("Rate-limit pressure");
    expect(rateHtml).toContain(">high<");
    expect(rateHtml).toContain("Rate-limit reset");
    expect(rateHtml).toContain("2026-05-26T00:05:00.000Z");
    expect(rateHtml).not.toContain("rawRateLimitPayload");
    expect(rateHtml).not.toContain("remaining");
  });

  it("renders compact file activity summary without exposing diff text", () => {
    const { profiler } = loadProfiler();
    const snapshot = activeSnapshot();
    const run = snapshot.run as Record<string, unknown>;
    run.currentActivity = {
      stage: "implementation",
      step: "edit monitor",
      stepElapsedMs: 4000,
      lastEventAgeMs: 1000,
      lastMeaningfulActivity: {
        kind: "file_change",
        label: "File-change metadata observed",
        ageMs: 3000,
        observedAt: "2026-05-26T00:00:07.000Z",
        fileActivity: {
          changedFileCount: 2,
          lastFile: "src/monitor-contracts.ts",
          category: "source",
          diff: "+raw diff should not render"
        }
      }
    };

    const html = profiler.renderSnapshot(snapshot, { serverNow: "2026-05-26T00:00:12.000Z" });

    expect(html).toContain("File change");
    expect(html).toContain("Changed files");
    expect(html).toContain(">2<");
    expect(html).toContain("Last file");
    expect(html).toContain("src/monitor-contracts.ts");
    expect(html).toContain("File category");
    expect(html).toContain(">source<");
    expect(html).not.toContain("raw diff");
  });

  it("renders missing file activity fields compactly", () => {
    const { profiler } = loadProfiler();
    const snapshot = activeSnapshot();
    const run = snapshot.run as Record<string, unknown>;
    run.currentActivity = {
      stage: "implementation",
      step: "edit monitor",
      stepElapsedMs: 4000,
      lastEventAgeMs: 1000,
      lastMeaningfulActivity: {
        kind: "file_change",
        label: "File-change metadata observed",
        ageMs: 3000,
        observedAt: "2026-05-26T00:00:07.000Z",
        fileActivity: {
          category: "unknown"
        }
      }
    };

    const html = profiler.renderSnapshot(snapshot, { serverNow: "2026-05-26T00:00:12.000Z" });

    expect(html).toContain("Changed files");
    expect(html).toContain("Unknown");
    expect(html).toContain("Last file");
    expect(html).toContain("Unavailable");
    expect(html).toContain("File category");
    expect(html).toContain(">unknown<");
  });

  it("renders required Human Action details only when action is required", () => {
    const { profiler } = loadProfiler();
    const html = profiler.renderSnapshot(humanActionSnapshot(), { serverNow: "2026-05-26T00:00:08.000Z" });

    expect(html).toContain("Human action");
    expect(html).toContain("Supervisor decision required");
    expect(html).toContain("Review validation evidence");
    expect(html).toContain("Stopped because");
    expect(html).toContain("You should");
    expect(html).toContain("Manual test");
    expect(html).toContain("Expected result");
    expect(html).toContain("Recommended next step");
    expect(html).not.toContain("<button");
  });

  it.each([
    [
      "planning-required",
      pauseSnapshot({
        issue: { id: "VER-164", title: "Preserve PR and validation metadata" },
        stage: "Pre-dispatch",
        step: "Planning/decomposition required",
        stoppedBecause: "prior planning_required pause needs bounded Active-Scope or linked decomposition evidence",
        youShould: "Create or attach a bounded planning/decomposition artifact before continuing.",
        recommendedNextStep: "Add a bounded Active Scope or split follow-up issues, then return the issue to an active state."
      }),
      ["Planning/decomposition required", "bounded Active-Scope", "bounded planning/decomposition artifact", "split follow-up issues"]
    ],
    [
      "recovery-needed",
      pauseSnapshot({
        issue: { id: "VER-170", title: "Recover clean workspace" },
        stage: "Pre-dispatch",
        step: "Workspace recovery needed",
        stoppedBecause: "recoverable partial work found: workspace has uncommitted changes",
        youShould: "Resume the existing workspace, preserve its changes, validate, then record recovery.",
        recommendedNextStep: "Commit or push the recovered workspace evidence, then run the documented recovery command."
      }),
      ["Workspace recovery needed", "recoverable partial work", "preserve its changes", "documented recovery command"]
    ],
    [
      "scope-large",
      pauseSnapshot({
        issue: { id: "VER-171", title: "Large monitor parent" },
        stage: "Scope guardrail",
        step: "Planning/decomposition required",
        stoppedBecause: "likely-large scope needs planning or decomposition before implementation dispatch",
        youShould: "Create or attach a bounded planning/decomposition artifact before continuing.",
        recommendedNextStep: "Add a bounded Active Scope or split follow-up issues, then return the issue to an active state."
      }),
      ["likely-large scope", "planning or decomposition", "bounded planning/decomposition artifact", "Active Scope"]
    ],
    [
      "human-action",
      pauseSnapshot({
        issue: { id: "VER-172", title: "Human decision required" },
        stage: "Review",
        step: "Human action required",
        stoppedBecause: "Supervisor decision required",
        youShould: "Review validation evidence",
        recommendedNextStep: "Record the requested human input, then continue the run from the latest evidence."
      }),
      ["Human action required", "Supervisor decision required", "Review validation evidence", "Record the requested human input"]
    ]
  ])("renders visible operator messages for %s pause snapshots without legacy trace parsing", (_label, snapshot, expectedMessages) => {
    const { profiler } = loadProfiler();
    const html = profiler.renderSnapshot(snapshot, { serverNow: "2026-05-26T00:00:10.000Z" });

    expect(html).toContain("Human action");
    expect(html).toContain("Stopped because");
    expect(html).toContain("You should");
    expect(html).toContain("Manual test");
    expect(html).toContain("Expected result");
    expect(html).toContain("Recommended next step");
    for (const message of expectedMessages) expect(html).toContain(message);
    expect(html).not.toContain("legacy trace parser only");
    expect(html).not.toContain("raw legacy event");
    expect(html).not.toContain("<button");
  });

  it("renders failed and completed terminal states with immutable finished durations", () => {
    const { profiler } = loadProfiler();
    const failed = profiler.renderSnapshot(terminalSnapshot("failed"), { serverNow: "2026-05-26T00:01:00.000Z" });
    const completed = profiler.renderSnapshot(terminalSnapshot("completed"), { serverNow: "2026-05-26T00:01:00.000Z" });

    expect(failed).toContain("Failed");
    expect(failed).toContain("Validation failed");
    expect(failed).toContain('data-ms="5000"');
    expect(completed).toContain("Completed");
    expect(completed).toContain("Run completed");
    expect(completed).toContain('data-ms="5000"');
  });

  it("renders standalone launcher ownership and Stop availability from existing launcher state", () => {
    const { profiler, strip, document } = loadProfiler({ launcherApi: {} });

    profiler.setStandaloneMode(false);
    expect(strip.hidden).toBe(true);
    expect(strip.innerHTML).toBe("");
    expect(document.body.dataset.mode).toBe("browser");

    profiler.setStandaloneMode(true, { status: "running", managedByLauncher: true, stopEnabled: true, pid: 1234 });
    expect(strip.hidden).toBe(false);
    expect(document.body.dataset.mode).toBe("standalone");
    expect(strip.innerHTML).toContain("Launcher: running");
    expect(strip.innerHTML).toContain("Daemon: launcher-owned pid 1234");
    expect(strip.innerHTML).toContain("Stop available: launcher owns this daemon");
    expect(strip.innerHTML).toContain(">Start<");
    expect(strip.innerHTML).toContain(">Stop<");
    expect(strip.innerHTML).toContain(">Reload/Open<");
    expect(strip.innerHTML).toContain('data-launcher-action="stop">Stop');
  });

  it("shows why standalone Stop is unavailable for externally managed daemons", () => {
    const { profiler, strip } = loadProfiler({ launcherApi: {} });

    profiler.setStandaloneMode(true, { status: "attached", managedByLauncher: false, stopEnabled: false });

    expect(strip.innerHTML).toContain("Launcher: attached");
    expect(strip.innerHTML).toContain("Daemon: externally managed");
    expect(strip.innerHTML).toContain("Stop unavailable: daemon is externally managed");
    expect(strip.innerHTML).toContain('data-launcher-action="stop" disabled');
  });

  it("keeps browser mode read-only with no standalone launcher controls", () => {
    const { profiler, strip, document } = loadProfiler({ launcherApi: {} });

    profiler.setStandaloneMode(false, { status: "running", managedByLauncher: true, stopEnabled: true });

    expect(document.body.dataset.mode).toBe("browser");
    expect(strip.hidden).toBe(true);
    expect(strip.innerHTML).toBe("");
  });
});

function loadProfiler(options: LoadProfilerOptions = {}): { profiler: ProfilerApi; strip: FakeElement; document: FakeDocument } {
  const dashboard = readFileSync(join(process.cwd(), "dashboard", "index.html"), "utf8");
  const script = dashboard.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("dashboard script not found");

  const root = new FakeElement();
  const strip = new FakeElement();
  const document = new FakeDocument(root, strip);
  const window = {
    __AGENTOS_MONITOR_TEST__: true,
    __AgentOSMonitorProfiler: undefined as ProfilerApi | undefined,
    location: { search: "" },
    ...(options.launcherApi ? { agentOsLauncher: options.launcherApi } : {})
  };
  const sandbox = {
    window,
    document,
    URLSearchParams,
    Date,
    JSON,
    Error,
    Number,
    String,
    Math,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ serverNow: "2026-05-26T00:00:00.000Z", status: "idle" }) }),
    console
  };

  vm.runInNewContext(script, sandbox);
  if (!window.__AgentOSMonitorProfiler) throw new Error("dashboard profiler API not exposed");
  return { profiler: window.__AgentOSMonitorProfiler, strip, document };
}

function activeSnapshot(status = "active"): Record<string, unknown> {
  return {
    serverNow: "2026-05-26T00:00:10.000Z",
    status,
    run: {
      runId: "run-1",
      issue: { id: "VER-156", title: "Replace dashboard UI", url: "https://linear.app/veritystudio/issue/VER-156", linearStatus: "In Progress" },
      attempt: { current: 0, max: 3 },
      runElapsedMs: 10000,
      currentModel: "gpt-5",
      links: { linear: "https://linear.app/veritystudio/issue/VER-156" },
      summary: { why: "Build profiler", build: "Dashboard HTML", done: "Rendering live snapshot" },
      currentActivity: { stage: "implementation", step: "render UI", stepElapsedMs: 4000, lastEventAgeMs: 1000 },
      timing: [
        {
          id: "run",
          label: "Run",
          status: status === "waiting" ? "waiting" : "active",
          timeClass: status === "waiting" ? "external-wait" : "agent",
          startedAt: "2026-05-26T00:00:00.000Z",
          durationMs: 10000,
          selfMs: 10000,
          waitMs: status === "waiting" ? 10000 : 0,
          children: []
        }
      ],
      topTimeSinks: [{ id: "run", label: "Run", selfMs: 10000, timeClass: "agent" }],
      humanAction: notNeededAction()
    }
  };
}

function humanActionSnapshot(): Record<string, unknown> {
  const snapshot = activeSnapshot("human_action");
  const run = snapshot.run as Record<string, unknown>;
  run.humanAction = {
    required: true,
    stoppedBecause: "Supervisor decision required",
    youShould: "Review validation evidence",
    manualTest: "Open the profiler",
    expectedResult: "Timing table is centered",
    recommendedNextStep: "Move to Human Review"
  };
  return snapshot;
}

function pauseSnapshot(options: {
  issue: { id: string; title: string };
  stage: string;
  step: string;
  stoppedBecause: string;
  youShould: string;
  recommendedNextStep: string;
}): Record<string, unknown> {
  return {
    serverNow: "2026-05-26T00:00:05.000Z",
    status: "human_action",
    legacyTrace: "legacy trace parser only",
    events: [{ message: "raw legacy event" }],
    run: {
      runId: `pause-${options.issue.id}`,
      issue: options.issue,
      attempt: { current: 0, max: 3 },
      runElapsedMs: 5000,
      links: {},
      summary: { why: `Work on ${options.issue.id}: ${options.issue.title}`, build: "Test coverage is in scope.", done: "Waiting for a human action." },
      currentActivity: { stage: options.stage, step: options.step, stepElapsedMs: 5000, lastEventAgeMs: 0 },
      timing: [
        {
          id: "pause",
          label: options.step,
          status: "waiting",
          timeClass: "human-wait",
          startedAt: "2026-05-26T00:00:00.000Z",
          durationMs: 5000,
          selfMs: 5000,
          waitMs: 5000,
          children: []
        }
      ],
      topTimeSinks: [{ id: "pause", label: options.step, selfMs: 5000, timeClass: "human-wait" }],
      humanAction: {
        required: true,
        stoppedBecause: options.stoppedBecause,
        youShould: options.youShould,
        manualTest: "Manual test could not be inferred from the available monitor data.",
        expectedResult: "Expected result could not be inferred from the available monitor data.",
        recommendedNextStep: options.recommendedNextStep
      }
    }
  };
}

function terminalSnapshot(status: "failed" | "completed"): Record<string, unknown> {
  const snapshot = activeSnapshot(status);
  snapshot.serverNow = "2026-05-26T00:00:05.000Z";
  const run = snapshot.run as Record<string, unknown>;
  run.runElapsedMs = 5000;
  run.summary = { why: "Build profiler", build: "Dashboard HTML", done: status === "failed" ? "Validation failed" : "Run completed" };
  run.currentActivity = { stage: status, step: status, stepElapsedMs: 5000, lastEventAgeMs: 0 };
  run.timing = [
    {
      id: "run",
      label: "Run",
      status: status === "failed" ? "failed" : "done",
      timeClass: "agent",
      startedAt: "2026-05-26T00:00:00.000Z",
      endedAt: "2026-05-26T00:00:05.000Z",
      durationMs: 5000,
      selfMs: 5000,
      waitMs: 0,
      children: []
    }
  ];
  run.topTimeSinks = [{ id: "run", label: "Run", selfMs: 5000, timeClass: "agent" }];
  run.humanAction = notNeededAction();
  return snapshot;
}

function nestedWaitSnapshot(): Record<string, unknown> {
  const snapshot = activeSnapshot("completed");
  const run = snapshot.run as Record<string, unknown>;
  run.timing = [
    {
      id: "parent",
      label: "Validation",
      status: "done",
      timeClass: "validation",
      startedAt: "2026-05-26T00:00:00.000Z",
      endedAt: "2026-05-26T00:00:10.000Z",
      durationMs: 10000,
      selfMs: 6000,
      waitMs: 4000,
      children: [
        {
          id: "wait",
          label: "Waiting for CI",
          status: "done",
          timeClass: "external-wait",
          startedAt: "2026-05-26T00:00:02.000Z",
          endedAt: "2026-05-26T00:00:06.000Z",
          durationMs: 4000,
          selfMs: 4000,
          waitMs: 4000,
          children: []
        }
      ]
    }
  ];
  return snapshot;
}

function commandRowsSnapshot(): Record<string, unknown> {
  const snapshot = activeSnapshot("active");
  const run = snapshot.run as Record<string, unknown>;
  run.timing = [
    {
      id: "turn",
      label: "implementation turn 1",
      status: "active",
      timeClass: "agent",
      startedAt: "2026-05-26T00:00:01.000Z",
      durationMs: 11000,
      selfMs: 1000,
      waitMs: 0,
      children: [
        {
          id: "cmd-active",
          label: "Command: npm run active",
          status: "active",
          timeClass: "tool",
          startedAt: "2026-05-26T00:00:02.000Z",
          durationMs: 10000,
          selfMs: 10000,
          waitMs: 0,
          result: "running",
          output: "raw stdout should not render",
          children: []
        },
        {
          id: "cmd-pass",
          label: "Command: npm run pass",
          status: "pass",
          timeClass: "tool",
          startedAt: "2026-05-26T00:00:03.000Z",
          endedAt: "2026-05-26T00:00:05.000Z",
          durationMs: 2000,
          selfMs: 2000,
          waitMs: 0,
          result: "exit 0",
          stderr: "raw stderr should not render",
          children: []
        },
        {
          id: "cmd-fail",
          label: "Command: npm run fail",
          status: "failed",
          timeClass: "tool",
          startedAt: "2026-05-26T00:00:06.000Z",
          endedAt: "2026-05-26T00:00:10.000Z",
          durationMs: 4000,
          selfMs: 4000,
          waitMs: 0,
          result: "exit 2",
          children: []
        }
      ]
    }
  ];
  return snapshot;
}

function notNeededAction(): Record<string, unknown> {
  return {
    required: false,
    stoppedBecause: "Not needed",
    youShould: "Not needed",
    manualTest: "Not needed",
    expectedResult: "Not needed",
    recommendedNextStep: "Not needed"
  };
}

function sectionNames(html: string): string[] {
  return [...html.matchAll(/<section[^>]*data-section="([^"]+)"/g)].map((match) => decodeHtml(match[1]));
}

function linkLabels(html: string): string[] {
  const section = html.match(/data-section="Links"[\s\S]*?<div class="links-grid">([\s\S]*?)<\/div>/)?.[1] ?? "";
  return [...section.matchAll(/(?:<a|<span)[^>]*>([^<]+)</g)].map((match) => decodeHtml(match[1]));
}

function rowHtml(html: string, rowId: string): string {
  return html.match(new RegExp(`<tr data-row-id="${rowId}"[\\s\\S]*?<\\/tr>`))?.[0] ?? "";
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

class FakeElement {
  hidden = false;
  innerHTML = "";
}

class FakeDocument {
  body = { dataset: {} as Record<string, string> };

  constructor(
    private root: FakeElement,
    private strip: FakeElement
  ) {}

  querySelector(selector: string): FakeElement | null {
    if (selector === "#profiler") return this.root;
    if (selector === "#launcher-strip") return this.strip;
    return null;
  }
}
