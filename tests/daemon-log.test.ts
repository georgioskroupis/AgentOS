import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendDaemonLaunchMarker, appendDaemonStopMarker, formatDaemonCrashTrace } from "../src/daemon-log.js";

describe("daemon log capture", () => {
  it("formats uncaught crash traces with an ISO timestamp header", () => {
    const trace = formatDaemonCrashTrace(new Error("boom"), "uncaughtException", {
      now: new Date("2026-05-20T00:00:00.123Z"),
      pid: 12345
    });

    expect(trace).toContain("==== agent-os orchestrator uncaughtException at 2026-05-20T00:00:00.123Z pid=12345 ====");
    expect(trace).toContain("Error: boom");
  });

  it("appends a clean stop marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-daemon-log-stop-"));
    const logPath = join(root, ".agent-os", "daemon.log");

    appendDaemonStopMarker(logPath, { now: new Date("2026-05-20T00:01:00.000Z") });

    await expect(readFile(logPath, "utf8")).resolves.toContain("==== agent-os orchestrator stopped cleanly at 2026-05-20T00:01:00.000Z ====");
  });

  it("appends a new launch marker after the previous clean stop marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-daemon-log-restart-"));
    const logPath = join(root, ".agent-os", "daemon.log");
    const firstLaunch = "==== agent-os orchestrator launched at 2026-05-20T00:00:00.000Z pid=111 startGitSha=aaa111 ====";
    const stop = "==== agent-os orchestrator stopped cleanly at 2026-05-20T00:01:00.000Z ====";
    const secondLaunch = "==== agent-os orchestrator launched at 2026-05-20T00:02:00.000Z pid=222 startGitSha=bbb222 ====";

    appendDaemonLaunchMarker(logPath, { now: new Date("2026-05-20T00:00:00.000Z"), pid: 111, startGitSha: "aaa111" });
    appendDaemonStopMarker(logPath, { now: new Date("2026-05-20T00:01:00.000Z") });
    appendDaemonLaunchMarker(logPath, { now: new Date("2026-05-20T00:02:00.000Z"), pid: 222, startGitSha: "bbb222" });

    const log = await readFile(logPath, "utf8");
    expect(log).toContain(firstLaunch);
    expect(log).toContain(stop);
    expect(log).toContain(secondLaunch);
    expect(log.indexOf(stop)).toBeGreaterThan(log.indexOf(firstLaunch));
    expect(log.indexOf(secondLaunch)).toBeGreaterThan(log.indexOf(stop));
  });
});
