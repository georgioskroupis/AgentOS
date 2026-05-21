import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { appendDaemonLaunchMarker, appendDaemonStopMarker, DAEMON_LOG_ENV, formatDaemonCrashTrace } from "../src/daemon-log.js";

describe("daemon log capture", () => {
  it("formats uncaught crash traces with an ISO timestamp header", () => {
    const trace = formatDaemonCrashTrace(new Error("boom"), "uncaughtException", {
      now: new Date("2026-05-20T00:00:00.123Z"),
      pid: 12345
    });

    expect(trace).toContain("==== agent-os orchestrator uncaughtException at 2026-05-20T00:00:00.123Z pid=12345 ====");
    expect(trace).toContain("Error: boom");
  });

  it("captures an installed uncaught throw with an ISO timestamp header", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-daemon-log-crash-"));
    const logPath = join(root, ".agent-os", "daemon.log");
    const daemonLogModule = pathToFileURL(resolve("src/daemon-log.ts")).href;
    const script = `
      import { DAEMON_LOG_ENV, installDaemonCrashCapture } from ${JSON.stringify(daemonLogModule)};
      const logPath = process.env[DAEMON_LOG_ENV];
      if (!logPath) throw new Error("missing daemon log env");
      installDaemonCrashCapture(logPath);
      setTimeout(() => {
        throw new Error("daemon child boom");
      }, 0);
    `;

    const result = await execNode(["--import", "tsx", "--input-type=module", "--eval", script], { [DAEMON_LOG_ENV]: logPath });

    expect(result.exitCode).toBe(1);
    const log = await readFile(logPath, "utf8");
    expect(log).toMatch(/^==== agent-os orchestrator uncaughtException at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z pid=\d+ ====/m);
    expect(log).toContain("Error: daemon child boom");
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

function execNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolveResult({
        exitCode: error ? exitCode(error) : 0,
        stdout,
        stderr
      });
    });
  });
}

function exitCode(error: Error & { code?: unknown }): number | null {
  return typeof error.code === "number" ? error.code : null;
}
