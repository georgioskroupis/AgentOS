import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryMonitorAggregator, type MonitorEvent } from "../src/index.js";
import { startAgentOsHttpServer, type AgentOsHttpServerHandle } from "../src/http-server.js";

const handles: AgentOsHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("AgentOS monitor API", () => {
  it("is disabled without an explicit port", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-disabled-"));
    await expect(startAgentOsHttpServer({ repoRoot: repo })).resolves.toBeNull();
  });

  it("serves the static dashboard route and rejects non-GET API methods", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-placeholder-"));
    const server = await startAgentOsHttpServer({ repoRoot: repo, port: 0 });
    expect(server).not.toBeNull();
    handles.push(server!);

    const root = await fetch(`${server!.url}/`);
    expect(root.status).toBe(200);
    await expect(root.text()).resolves.toContain("AgentOS Monitor");

    const method = await fetch(`${server!.url}/`, { method: "POST" });
    expect(method.status).toBe(405);
    await expect(method.json()).resolves.toMatchObject({ success: false, error: { code: "method_not_allowed" } });

    for (const route of ["/api/monitor/v1/snapshot", "/api/monitor/v1/health", "/api/monitor/v1/stream"]) {
      const response = await fetch(`${server!.url}${route}`, { method: "POST" });
      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toMatchObject({ success: false, error: { code: "method_not_allowed" } });
    }
  });

  it("does not expose legacy or mutating monitor API routes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-no-legacy-"));
    const server = await startAgentOsHttpServer({ repoRoot: repo, port: 0 });
    expect(server).not.toBeNull();
    handles.push(server!);
    const oldApiRoot = ["", "api", "v1"].join("/");

    for (const [path, init] of [
      [`${oldApiRoot}/state`, undefined],
      [`${oldApiRoot}/VER-96`, undefined],
      [`${oldApiRoot}/refresh`, { method: "POST" }],
      ["/api/monitor/v1/start", undefined],
      ["/api/monitor/v1/stop", undefined],
      ["/api/monitor/v1/restart", undefined],
      ["/api/monitor/v1/refresh", { method: "POST" }]
    ] as const) {
      const response = await fetch(`${server!.url}${path}`, init);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ success: false, error: { code: "not_found" } });
    }
  });

  it("returns idle, active, waiting, human-action, failed, completed, missing-link, and tiny health snapshots", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-snapshot-"));
    const monitor = new InMemoryMonitorAggregator();
    const server = await startAgentOsHttpServer({ repoRoot: repo, port: 0, monitor });
    expect(server).not.toBeNull();
    handles.push(server!);

    await expect(fetchJson(`${server!.url}/api/monitor/v1/snapshot`)).resolves.toMatchObject({ status: "idle" });

    monitor.emit(event("run", "run_started", "Run VER-155", "2026-05-26T00:00:00.000Z"));
    const active = await fetchJson(`${server!.url}/api/monitor/v1/snapshot`);
    expect(active).toMatchObject({ status: "active", run: { runId: "run-1", issue: { id: "VER-155", title: "Run VER-155" }, links: {} } });

    const activeText = JSON.stringify(active);
    expect(activeText).not.toContain("raw");
    expect(activeText).not.toContain("prompt");

    monitor.emit(event("wait", "wait_started", "Waiting for CI", "2026-05-26T00:00:02.000Z", { parentSpanId: "run", timeClass: "external-wait", status: "waiting" }));
    await expect(fetchJson(`${server!.url}/api/monitor/v1/snapshot`)).resolves.toMatchObject({ status: "waiting" });

    monitor.emit(event("human", "human_action_required", "Needs review", "2026-05-26T00:00:03.000Z", { result: "Supervisor decision required" }));
    await expect(fetchJson(`${server!.url}/api/monitor/v1/snapshot`)).resolves.toMatchObject({
      status: "human_action",
      run: { humanAction: { required: true, recommendedNextStep: "Record the requested human input, then continue the run from the latest evidence." } }
    });

    monitor.emit(event("run", "run_failed", "Run failed", "2026-05-26T00:00:04.000Z", { result: "Validation failed", status: "failed" }));
    await expect(fetchJson(`${server!.url}/api/monitor/v1/snapshot`)).resolves.toMatchObject({ status: "failed", serverNow: "2026-05-26T00:00:04.000Z" });

    const health = await fetchJson(`${server!.url}/api/monitor/v1/health`);
    expect(Object.keys(health).sort()).toEqual(["issueId", "ok", "runId", "serverNow", "status"]);
    expect(health).toMatchObject({ ok: true, status: "failed", runId: "run-1", issueId: "VER-155" });

    const completedMonitor = new InMemoryMonitorAggregator();
    const completedServer = await startAgentOsHttpServer({ repoRoot: repo, port: 0, monitor: completedMonitor });
    expect(completedServer).not.toBeNull();
    handles.push(completedServer!);
    completedMonitor.emit(event("run", "run_started", "Run VER-156", "2026-05-26T00:01:00.000Z", { runId: "run-2", issueId: "VER-156" }));
    completedMonitor.emit(event("run", "run_finished", "Run finished", "2026-05-26T00:01:05.000Z", { runId: "run-2", issueId: "VER-156", result: "Done" }));
    await expect(fetchJson(`${completedServer!.url}/api/monitor/v1/snapshot`)).resolves.toMatchObject({ status: "completed", run: { runId: "run-2" } });
  });

  it("streams monitor snapshots, heartbeat events, terminal snapshots, and supports reconnect by snapshot refetch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-stream-"));
    const monitor = new InMemoryMonitorAggregator();
    const server = await startAgentOsHttpServer({ repoRoot: repo, port: 0, monitor, monitorHeartbeatMs: 10000 });
    expect(server).not.toBeNull();
    handles.push(server!);

    const stream = await fetch(`${server!.url}/api/monitor/v1/stream`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();

    const heartbeat = await readSseEvents(reader, 1);
    expect(heartbeat.some((entry) => entry.event === "heartbeat")).toBe(true);

    monitor.emit(event("run", "run_started", "Run VER-155", "2026-05-26T00:00:00.000Z"));
    const active = await readSseEvents(reader, 1);
    expect(active).toEqual([{ event: "monitor_snapshot", data: expect.objectContaining({ status: "active" }) }]);

    monitor.emit(event("run", "run_failed", "Run failed", "2026-05-26T00:00:01.000Z", { status: "failed", result: "failed" }));
    const terminal = await readSseEvents(reader, 1);
    expect(terminal).toEqual([{ event: "monitor_snapshot", data: expect.objectContaining({ status: "failed", serverNow: "2026-05-26T00:00:01.000Z" }) }]);
    await reader.cancel();

    await expect(fetchJson(`${server!.url}/api/monitor/v1/snapshot`)).resolves.toMatchObject({ status: "failed", run: { runId: "run-1" } });
  });
});

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function readSseEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<Array<{ event: string; data: unknown }>> {
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ event: string; data: unknown }> = [];
  const timeout = Date.now() + 1000;
  while (events.length < count && Date.now() < timeout) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSse(raw);
      if (parsed) events.push(parsed);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

function parseSse(raw: string): { event: string; data: unknown } | null {
  const lines = raw.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (!eventLine || !dataLine) return null;
  return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
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
    issueId: "VER-155",
    timestamp,
    kind,
    label,
    status: kind.endsWith("_started") ? "active" : kind === "run_failed" ? "failed" : "done",
    timeClass: "agent",
    ...options
  };
}
