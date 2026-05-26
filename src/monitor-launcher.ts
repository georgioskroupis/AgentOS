import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { LauncherConfig, LauncherState } from "./monitor-extension-contracts.js";

export const launcherConfigRelativePath = join("Library", "Application Support", "AgentOS Monitor", "config.json");
export const launcherHealthPath = "/api/monitor/v1/health";
export const launcherGracefulShutdownSignal: NodeJS.Signals = "SIGTERM";
export const launcherEscalationSignal: NodeJS.Signals = "SIGKILL";

type LauncherFetchResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

type LauncherFetch = (url: string, init?: { method: "GET"; cache: "no-store" }) => Promise<LauncherFetchResponse>;

type LauncherChildProcess = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill" | "once"> & {
  off?(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): LauncherChildProcess;
};

type LauncherSpawn = (command: string, args: string[], options: { cwd: string; stdio: "ignore" }) => LauncherChildProcess;

export type LauncherCommand = {
  command: string;
  args: string[];
  cwd: string;
};

export type LauncherProcessManagerOptions = {
  configPath?: string;
  homeDir?: string;
  fetch?: LauncherFetch;
  spawn?: LauncherSpawn;
  portInUse?: (host: string, port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  gracefulShutdownMs?: number;
};

export class AgentOsLauncherProcessManager {
  private child: LauncherChildProcess | undefined;
  private state: LauncherState | undefined;
  private readonly configPath: string;
  private readonly fetch: LauncherFetch;
  private readonly spawn: LauncherSpawn;
  private readonly portInUse: (host: string, port: number) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly gracefulShutdownMs: number;

  constructor(options: LauncherProcessManagerOptions = {}) {
    this.configPath = options.configPath ?? defaultLauncherConfigPath(options.homeDir);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.portInUse = options.portInUse ?? isPortInUse;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 10000;
    this.readinessPollMs = options.readinessPollMs ?? 250;
    this.gracefulShutdownMs = options.gracefulShutdownMs ?? 3000;
  }

  currentState(): LauncherState | undefined {
    return this.state ? { ...this.state } : undefined;
  }

  async readConfig(): Promise<LauncherConfig> {
    const raw = await readFile(this.configPath, "utf8");
    return parseLauncherConfig(JSON.parse(raw));
  }

  async attach(config?: LauncherConfig): Promise<LauncherState> {
    const resolvedConfig = config ?? (await this.readConfig());
    if (!(await this.monitorHealthOk(resolvedConfig))) {
      return this.setState(resolvedConfig, "failed", {
        lastError: `No AgentOS monitor health endpoint is available at ${launcherUrl(resolvedConfig)}`
      });
    }
    this.child = undefined;
    return this.setState(resolvedConfig, "attached");
  }

  async start(config?: LauncherConfig): Promise<LauncherState> {
    const resolvedConfig = config ?? (await this.readConfig());
    this.setState(resolvedConfig, "starting");

    if (await this.portInUse(resolvedConfig.host, resolvedConfig.port)) {
      if (await this.monitorHealthOk(resolvedConfig)) {
        this.child = undefined;
        return this.setState(resolvedConfig, "attached");
      }
      return this.setState(resolvedConfig, "failed", {
        lastError: `Port ${resolvedConfig.port} is already in use by a non-AgentOS monitor process`
      });
    }

    const command = buildLauncherCommand(resolvedConfig);
    this.child = this.spawn(command.command, command.args, { cwd: command.cwd, stdio: "ignore" });
    this.setState(resolvedConfig, "starting", { pid: this.child.pid, startedAt: this.now().toISOString(), managedByLauncher: true });

    try {
      await this.waitForReadiness(resolvedConfig);
      return this.setState(resolvedConfig, "running", { pid: this.child?.pid, startedAt: this.state?.startedAt, managedByLauncher: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.stopOwnedChild();
      return this.setState(resolvedConfig, "failed", { lastError: message });
    }
  }

  async stop(): Promise<LauncherState | undefined> {
    const current = this.state;
    if (!current) return undefined;
    if (!current.managedByLauncher || !this.child) return { ...current, stopEnabled: false };

    this.state = { ...current, status: "stopping", stopEnabled: false };
    await this.stopOwnedChild();
    return this.setState(current, "stopped", { managedByLauncher: false });
  }

  private async waitForReadiness(config: LauncherConfig): Promise<void> {
    const startedAt = Date.now();
    let lastError = "health endpoint did not become ready";

    while (Date.now() - startedAt <= this.readinessTimeoutMs) {
      if (this.childExited()) throw new Error("AgentOS launcher process exited before monitor health became ready");
      if (await this.monitorHealthOk(config)) return;
      await this.sleep(this.readinessPollMs);
    }

    throw new Error(`Timed out waiting for ${launcherUrl(config)}${launcherHealthPath}: ${lastError}`);
  }

  private async monitorHealthOk(config: LauncherConfig): Promise<boolean> {
    try {
      const response = await this.fetch(`${launcherUrl(config)}${launcherHealthPath}`, { method: "GET", cache: "no-store" });
      if (!response.ok) return false;
      const body = await response.json();
      return typeof body === "object" && body != null && (body as { ok?: unknown }).ok === true;
    } catch {
      return false;
    }
  }

  private async stopOwnedChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!this.childExited()) {
      child.kill(launcherGracefulShutdownSignal);
      const exited = await waitForExit(child, this.gracefulShutdownMs);
      if (!exited && !this.childExited()) {
        child.kill(launcherEscalationSignal);
        await waitForExit(child, 100);
      }
    }
    if (this.child === child) this.child = undefined;
  }

  private childExited(): boolean {
    return this.child?.exitCode != null || this.child?.signalCode != null;
  }

  private setState(config: LauncherConfig | Pick<LauncherState, "repo" | "workflow" | "port">, status: LauncherState["status"], partial: Partial<LauncherState> = {}): LauncherState {
    const managedByLauncher = partial.managedByLauncher ?? (status === "running" || status === "starting" || status === "stopping" ? true : false);
    this.state = {
      repo: config.repo,
      workflow: config.workflow,
      port: config.port,
      url: "host" in config ? launcherUrl(config) : this.state?.url,
      managedByLauncher,
      stopEnabled: managedByLauncher && (status === "running" || status === "starting"),
      ...partial,
      status
    };
    return { ...this.state };
  }
}

export function defaultLauncherConfigPath(homeDir = homedir()): string {
  return join(homeDir, launcherConfigRelativePath);
}

export function buildLauncherCommand(config: LauncherConfig): LauncherCommand {
  return {
    command: config.command ?? "bin/agent-os",
    args: ["orchestrator", "run", "--repo", config.repo, "--workflow", config.workflow, "--port", String(config.port)],
    cwd: config.repo
  };
}

export function launcherUrl(config: Pick<LauncherConfig, "host" | "port">): string {
  return `http://${config.host}:${config.port}`;
}

export function parseLauncherConfig(value: unknown): LauncherConfig {
  if (typeof value !== "object" || value == null || Array.isArray(value)) throw new Error("Launcher config must be an object");
  const input = value as Partial<LauncherConfig>;
  if (typeof input.repo !== "string" || input.repo.length === 0) throw new Error("Launcher config repo must be a non-empty string");
  if (typeof input.workflow !== "string" || input.workflow.length === 0) throw new Error("Launcher config workflow must be a non-empty string");
  if (input.host !== "127.0.0.1") throw new Error("Launcher config host must be 127.0.0.1");
  const port = input.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Launcher config port must be an integer from 1 to 65535");
  if (input.command != null && (typeof input.command !== "string" || input.command.length === 0)) throw new Error("Launcher config command must be a non-empty string when provided");
  return {
    repo: input.repo,
    workflow: input.workflow,
    port,
    host: input.host,
    ...(input.command ? { command: input.command } : {})
  };
}

async function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (inUse: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED"));
  });
}

async function waitForExit(child: LauncherChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return true;
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off?.("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
