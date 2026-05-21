import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeDaemonIdentity } from "../src/daemon-identity.js";
import { exists } from "../src/fs-utils.js";
import { restartDaemon, startDaemon, stopDaemon } from "../src/daemon-lifecycle.js";

describe("daemon lifecycle commands", () => {
  it("starts a detached daemon for a stopped repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-start-"));
    const spawned: { script?: string; env?: NodeJS.ProcessEnv } = {};

    const result = await startDaemon({
      repoRoot: repo,
      workflowPath: "WORKFLOW.md",
      resolveStartGitSha: async () => "abc123",
      spawnDetached: (script, env) => {
        spawned.script = script;
        spawned.env = env;
        return { pid: 321, unref: () => undefined };
      }
    });

    expect(result.action).toBe("started");
    expect(result.pid).toBe(321);
    expect(result.nextSafeAction).toContain("daemon status");
    expect(spawned.script).toContain("echo $$ > .agent-os/daemon.pid");
    expect(spawned.script).toContain("orchestrator run --repo . --workflow 'WORKFLOW.md'");
    expect(spawned.env?.AGENT_OS_DAEMON_LOG).toBe(join(repo, ".agent-os", "daemon.log"));
    expect(spawned.env?.AGENT_OS_DAEMON_START_GIT_SHA).toBe("abc123");
  });

  it("removes stale PID state before starting", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-start-stale-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "daemon.pid"), "999998\n", "utf8");
    await writeFile(join(repo, ".agent-os", "daemon.log"), "old daemon output\n", "utf8");

    const result = await startDaemon({
      repoRoot: repo,
      resolveStartGitSha: async () => "abc123",
      spawnDetached: () => ({ pid: 654, unref: () => undefined })
    });

    expect(result.action).toBe("started");
    expect(await exists(join(repo, ".agent-os", "daemon.pid"))).toBe(false);
  });

  it("refuses to start over a verified live daemon", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-start-live-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "daemon.pid"), `${process.pid}\n`, "utf8");
    await writeDaemonIdentity(repo, { pid: process.pid, startedAt: "2026-05-21T00:00:00.000Z", startGitSha: "abc123" });

    const result = await startDaemon({
      repoRoot: repo,
      spawnDetached: () => {
        throw new Error("should not spawn");
      }
    });

    expect(result.action).toBe("refused");
    expect(result.message).toContain("verified live AgentOS process");
    expect(result.nextSafeAction).toContain("daemon restart");
  });

  it("refuses to start over an ambiguous live non-AgentOS PID", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-start-ambiguous-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "daemon.pid"), `${process.pid}\n`, "utf8");

    const result = await startDaemon({
      repoRoot: repo,
      spawnDetached: () => {
        throw new Error("should not spawn");
      }
    });

    expect(result.action).toBe("refused");
    expect(result.message).toContain("PID state is ambiguous");
    expect(result.nextSafeAction).toContain("do not run daemon start/restart");
  });

  it("cleans stale PID state on stop", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-stop-stale-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "daemon.pid"), "999998\n", "utf8");
    await writeFile(join(repo, ".agent-os", "daemon.log"), "old daemon output\n", "utf8");

    const result = await stopDaemon({ repoRoot: repo });

    expect(result.action).toBe("cleaned_stale_pid");
    expect(await exists(join(repo, ".agent-os", "daemon.pid"))).toBe(false);
  });

  it("stops a verified live daemon without touching ambiguous processes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-stop-live-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "daemon.pid"), "12345\n", "utf8");
    await writeDaemonIdentity(repo, { pid: 12345, startedAt: "2026-05-21T00:00:00.000Z", startGitSha: "abc123" });
    let alive = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopDaemon({
      repoRoot: repo,
      isProcessAlive: (pid) => pid === 12345 && alive,
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal });
        alive = false;
      },
      pollIntervalMs: 1,
      waitForStopMs: 50
    });

    expect(result.action).toBe("stopped");
    expect(signals).toEqual([{ pid: 12345, signal: "SIGTERM" }]);
    expect(await exists(join(repo, ".agent-os", "daemon.pid"))).toBe(false);
  });

  it("stops a verified daemon from identity metadata when the PID file is missing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-stop-identity-"));
    await writeDaemonIdentity(repo, { pid: 12345, startedAt: "2026-05-21T00:00:00.000Z", startGitSha: "abc123" });
    let alive = true;

    const result = await stopDaemon({
      repoRoot: repo,
      isProcessAlive: (pid) => pid === 12345 && alive,
      signalProcess: () => {
        alive = false;
      },
      pollIntervalMs: 1,
      waitForStopMs: 50
    });

    expect(result.action).toBe("stopped");
    expect(result.pid).toBe(12345);
    expect(await exists(join(repo, ".agent-os", "state", "daemon-identity.json"))).toBe(false);
  });

  it("treats a process that exits before SIGTERM as stopped", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-stop-race-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "daemon.pid"), "12345\n", "utf8");
    await writeDaemonIdentity(repo, { pid: 12345, startedAt: "2026-05-21T00:00:00.000Z", startGitSha: "abc123" });
    let alive = true;

    const result = await stopDaemon({
      repoRoot: repo,
      isProcessAlive: (pid) => pid === 12345 && alive,
      signalProcess: () => {
        alive = false;
        throw new Error("process already exited");
      },
      pollIntervalMs: 1,
      waitForStopMs: 50
    });

    expect(result.action).toBe("stopped");
    expect(await exists(join(repo, ".agent-os", "daemon.pid"))).toBe(false);
  });

  it("restarts by composing stop and start", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-restart-"));

    const result = await restartDaemon({
      repoRoot: repo,
      resolveStartGitSha: async () => "abc123",
      spawnDetached: () => ({ pid: 777, unref: () => undefined })
    });

    expect(result.action).toBe("restarted");
    expect(result.pid).toBe(777);
  });
});
