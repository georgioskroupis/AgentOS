import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AgentOsLauncherProcessManager, buildLauncherCommand, defaultLauncherConfigPath, launcherEscalationSignal, launcherGracefulShutdownSignal, parseLauncherConfig, type LauncherCommand } from "../src/index.js";
import type { LauncherConfig } from "../src/index.js";

const config: LauncherConfig = {
  repo: "/repo",
  workflow: "WORKFLOW.md",
  host: "127.0.0.1",
  port: 4317
};

describe("AgentOS monitor launcher process manager", () => {
  it("constructs the owned AgentOS monitor command from LauncherConfig", () => {
    expect(buildLauncherCommand(config)).toEqual<LauncherCommand>({
      command: "bin/agent-os",
      args: ["orchestrator", "run", "--repo", "/repo", "--workflow", "WORKFLOW.md", "--port", "4317"],
      cwd: "/repo"
    });
  });

  it("loads LauncherConfig from the local macOS config path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentos-launcher-config-"));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const manager = new AgentOsLauncherProcessManager({
      configPath,
      fetch: async () => health(false),
      portInUse: async () => false,
      spawn: () => new FakeChild(),
      readinessTimeoutMs: 0,
      sleep: async () => {}
    });

    expect(defaultLauncherConfigPath("/Users/me")).toBe("/Users/me/Library/Application Support/AgentOS Monitor/config.json");
    await expect(manager.readConfig()).resolves.toEqual(config);
    await rm(dir, { recursive: true, force: true });
  });

  it("starts an owned child process and reports running after health readiness", async () => {
    const child = new FakeChild(1234);
    const spawned: LauncherCommand[] = [];
    const manager = new AgentOsLauncherProcessManager({
      fetch: async () => health(true),
      portInUse: async () => false,
      spawn: (command, args, options) => {
        spawned.push({ command, args, cwd: options.cwd });
        return child;
      },
      sleep: async () => {}
    });

    const state = await manager.start(config);

    expect(spawned).toEqual([buildLauncherCommand(config)]);
    expect(state).toMatchObject({ status: "running", pid: 1234, managedByLauncher: true, stopEnabled: true, url: "http://127.0.0.1:4317" });
  });

  it("stops only the owned child process with graceful shutdown before escalation", async () => {
    const child = new FakeChild(1234);
    const manager = new AgentOsLauncherProcessManager({
      fetch: async () => health(true),
      portInUse: async () => false,
      spawn: () => child,
      gracefulShutdownMs: 1,
      sleep: async () => {}
    });
    await manager.start(config);

    const stopPromise = manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.exit(0, null);
    const state = await stopPromise;

    expect(child.signals).toEqual([launcherGracefulShutdownSignal, launcherEscalationSignal]);
    expect(state).toMatchObject({ status: "stopped", managedByLauncher: false, stopEnabled: false });
  });

  it("does not escalate when the owned child exits during graceful shutdown", async () => {
    const child = new FakeChild(1234);
    child.exitOnKill = true;
    const manager = new AgentOsLauncherProcessManager({
      fetch: async () => health(true),
      portInUse: async () => false,
      spawn: () => child,
      gracefulShutdownMs: 50,
      sleep: async () => {}
    });
    await manager.start(config);

    const state = await manager.stop();

    expect(child.signals).toEqual([launcherGracefulShutdownSignal]);
    expect(state).toMatchObject({ status: "stopped", managedByLauncher: false, stopEnabled: false });
  });

  it("attaches read-only to an already-running monitor server and disables Stop", async () => {
    const child = new FakeChild();
    const manager = new AgentOsLauncherProcessManager({
      fetch: async () => health(true),
      portInUse: async () => true,
      spawn: () => child
    });

    const state = await manager.start(config);
    const afterStop = await manager.stop();

    expect(state).toMatchObject({ status: "attached", managedByLauncher: false, stopEnabled: false });
    expect(afterStop).toMatchObject({ status: "attached", managedByLauncher: false, stopEnabled: false });
    expect(child.signals).toEqual([]);
  });

  it("detects a non-monitor process already using the configured port", async () => {
    const manager = new AgentOsLauncherProcessManager({
      fetch: async () => health(false),
      portInUse: async () => true,
      spawn: () => new FakeChild()
    });

    const state = await manager.start(config);

    expect(state).toMatchObject({ status: "failed", managedByLauncher: false });
    expect(state.lastError).toContain("Port 4317 is already in use");
  });

  it("reports failed start when the owned process exits before health readiness", async () => {
    const child = new FakeChild(1234, 1);
    const manager = new AgentOsLauncherProcessManager({
      fetch: async () => health(false),
      portInUse: async () => false,
      spawn: () => child,
      readinessTimeoutMs: 1,
      sleep: async () => {}
    });

    const state = await manager.start(config);

    expect(state).toMatchObject({ status: "failed", managedByLauncher: false });
    expect(state.lastError).toContain("exited before monitor health became ready");
  });

  it("reports health timeout and shuts down the owned process", async () => {
    const child = new FakeChild(1234);
    const manager = new AgentOsLauncherProcessManager({
      fetch: async () => health(false),
      portInUse: async () => false,
      spawn: () => child,
      readinessTimeoutMs: 1,
      readinessPollMs: 1,
      gracefulShutdownMs: 1
    });

    const state = await manager.start(config);

    expect(state).toMatchObject({ status: "failed", managedByLauncher: false });
    expect(state.lastError).toContain("Timed out waiting");
    expect(child.signals).toContain(launcherGracefulShutdownSignal);
  });

  it("keeps source-core modules from importing launcher code", () => {
    const offenders = sourceCoreFiles()
      .map((file) => ({ file, text: readFileSync(file, "utf8") }))
      .filter(({ text }) => /monitor-launcher\.js|AgentOsLauncherProcessManager|buildLauncherCommand/.test(text))
      .map(({ file }) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});

function health(ok: boolean) {
  return {
    ok,
    async json() {
      return { ok };
    }
  };
}

class FakeChild extends EventEmitter {
  pid?: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: Array<NodeJS.Signals | number | undefined> = [];
  exitOnKill = false;

  constructor(pid = 1234, exitCode: number | null = null) {
    super();
    this.pid = pid;
    this.exitCode = exitCode;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.exitOnKill) this.exit(0, null);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function sourceCoreFiles(): string[] {
  const relativePaths = [
    "src/workflow.ts",
    "src/lifecycle.ts",
    "src/lifecycle-events.ts",
    "src/lifecycle-controller.ts",
    "src/agent-lifecycle.ts",
    "src/tracker-boundaries.ts",
    "src/tracker-adapters.ts",
    "src/linear.ts",
    "src/orchestrator-tracker-guard.ts",
    "src/workspace.ts",
    "src/orchestrator-workspace-bootstrap.ts",
    "src/runner/app-server.ts",
    "src/orchestrator.ts",
    "src/runs.ts",
    "src/runtime-state.ts",
    "src/recovery.ts",
    "src/orchestrator-terminal.ts",
    "src/issue-state.ts",
    "src/orchestrator-agent-owned-evidence.ts",
    "src/agent-owned-lifecycle-evidence.ts",
    "src/validation.ts",
    "src/validation-profile.ts",
    "src/orchestrator-validation.ts",
    "src/context-budget.ts",
    "src/context-pack.ts",
    "src/monitor-contracts.ts",
    "src/monitor-sink.ts",
    "src/status.ts",
    "src/status-diagnostics.ts"
  ];
  return relativePaths.map((path) => join(process.cwd(), path)).filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile());
}
