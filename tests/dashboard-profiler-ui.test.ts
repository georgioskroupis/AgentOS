import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type ProfilerApi = {
  renderSnapshot(snapshot: Record<string, unknown>, options?: Record<string, unknown>): string;
  setStandaloneMode(enabled: boolean, launcherState?: Record<string, unknown>): void;
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

  it("renders required Human Action details only when action is required", () => {
    const { profiler } = loadProfiler();
    const html = profiler.renderSnapshot(humanActionSnapshot(), { serverNow: "2026-05-26T00:00:08.000Z" });

    expect(html).toContain("Human action");
    expect(html).toContain("Supervisor decision required");
    expect(html).toContain("Review validation evidence");
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

  it("renders the standalone launcher strip only when standalone mode is enabled", () => {
    const { profiler, strip, document } = loadProfiler();

    profiler.setStandaloneMode(false);
    expect(strip.hidden).toBe(true);
    expect(strip.innerHTML).toBe("");
    expect(document.body.dataset.mode).toBe("browser");

    profiler.setStandaloneMode(true, { status: "running" });
    expect(strip.hidden).toBe(false);
    expect(document.body.dataset.mode).toBe("standalone");
    expect(strip.innerHTML).toContain("Launcher: running");
    expect(strip.innerHTML).toContain(">Start<");
    expect(strip.innerHTML).toContain(">Stop<");
    expect(strip.innerHTML).toContain(">Reload/Open<");
  });
});

function loadProfiler(): { profiler: ProfilerApi; strip: FakeElement; document: FakeDocument } {
  const dashboard = readFileSync(join(process.cwd(), "dashboard", "index.html"), "utf8");
  const script = dashboard.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("dashboard script not found");

  const root = new FakeElement();
  const strip = new FakeElement();
  const document = new FakeDocument(root, strip);
  const window = {
    __AGENTOS_MONITOR_TEST__: true,
    __AgentOSMonitorProfiler: undefined as ProfilerApi | undefined,
    location: { search: "" }
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
