import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { daemonIdentityPath, evaluateDaemonSingletonGuard } from "./daemon-identity.js";
import { DAEMON_LOG_ENV, DAEMON_START_GIT_SHA_ENV } from "./daemon-log.js";
import { daemonRestartCommand, daemonStartCommand, inspectDaemonHealth, type DaemonHealth } from "./daemon-health.js";
import { removePath } from "./fs-utils.js";

export type DaemonLifecycleAction = "started" | "stopped" | "restarted" | "noop" | "refused" | "cleaned_stale_pid";

export interface DaemonLifecycleResult {
  action: DaemonLifecycleAction;
  repoRoot: string;
  pid: number | null;
  message: string;
  nextSafeAction: string;
}

export interface DaemonLifecycleOptions {
  repoRoot?: string;
  workflowPath?: string;
  isProcessAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  spawnDetached?: (script: string, env: NodeJS.ProcessEnv) => { pid?: number; unref?: () => void };
  resolveStartGitSha?: (repoRoot: string) => Promise<string>;
  waitForStopMs?: number;
  pollIntervalMs?: number;
}

export async function startDaemon(options: DaemonLifecycleOptions = {}): Promise<DaemonLifecycleResult> {
  const root = resolve(options.repoRoot ?? process.cwd());
  const workflowPath = options.workflowPath ?? "WORKFLOW.md";
  const health = await inspectDaemonHealth(root, { isProcessAlive: options.isProcessAlive });
  const refusal = startRefusal(root, workflowPath, health);
  if (refusal) return refusal;
  if (health.status === "stale_pid" || health.status === "failed_launch") {
    await cleanupDaemonPidState(root, health);
  }

  const guard = await evaluateDaemonSingletonGuard(root, { isProcessAlive: options.isProcessAlive });
  if (!guard.allowed) {
    return refused(root, guard.identity?.pid ?? health.pid, guard.message, `inspect ${guard.path}, then stop the existing daemon before starting another one`);
  }

  await mkdir(join(root, ".agent-os"), { recursive: true });
  const startGitSha = await (options.resolveStartGitSha ?? resolveStartGitSha)(root);
  const logPath = join(root, ".agent-os", "daemon.log");
  const script = daemonShellScript(root, workflowPath, startGitSha);
  const child = (options.spawnDetached ?? spawnDaemonShell)(script, {
    ...process.env,
    [DAEMON_LOG_ENV]: logPath,
    [DAEMON_START_GIT_SHA_ENV]: startGitSha
  });
  child.unref?.();
  return {
    action: "started",
    repoRoot: root,
    pid: child.pid ?? null,
    message: `started AgentOS daemon for ${root}${child.pid ? ` with launcher pid ${child.pid}` : ""}`,
    nextSafeAction: `check daemon health with: bin/agent-os daemon status --repo ${shellQuote(root)}`
  };
}

export async function stopDaemon(options: DaemonLifecycleOptions = {}): Promise<DaemonLifecycleResult> {
  const root = resolve(options.repoRoot ?? process.cwd());
  const health = await inspectDaemonHealth(root, { isProcessAlive: options.isProcessAlive });
  if (health.status === "stopped") {
    const guard = await evaluateDaemonSingletonGuard(root, { isProcessAlive: options.isProcessAlive });
    if (!guard.allowed && guard.identity) {
      return await stopVerifiedPid(root, guard.identity.pid, options, daemonStartCommand(root, options.workflowPath ?? "WORKFLOW.md"));
    }
    return {
      action: "noop",
      repoRoot: root,
      pid: null,
      message: "no daemon PID file is present",
      nextSafeAction: daemonStartCommand(root, options.workflowPath ?? "WORKFLOW.md")
    };
  }
  if (health.status === "stale_pid" || health.status === "failed_launch") {
    await cleanupDaemonPidState(root, health);
    return {
      action: "cleaned_stale_pid",
      repoRoot: root,
      pid: health.pid,
      message: `removed stale daemon PID state for pid ${health.pid}`,
      nextSafeAction: daemonStartCommand(root, options.workflowPath ?? "WORKFLOW.md")
    };
  }
  if (health.status === "non_agentos_pid") {
    return refused(root, health.pid, health.message, health.nextSafeAction);
  }

  if (!health.pid) return refused(root, null, "daemon PID is unavailable", health.nextSafeAction);
  return await stopVerifiedPid(root, health.pid, options, daemonStartCommand(root, options.workflowPath ?? "WORKFLOW.md"));
}

async function stopVerifiedPid(root: string, pid: number, options: DaemonLifecycleOptions, nextStartAction: string): Promise<DaemonLifecycleResult> {
  const signalProcess = options.signalProcess ?? defaultSignalProcess;
  try {
    signalProcess(pid, "SIGTERM");
  } catch (error) {
    if ((options.isProcessAlive ?? defaultIsProcessAlive)(pid)) {
      return refused(root, pid, `failed to send SIGTERM to daemon pid ${pid}: ${error instanceof Error ? error.message : String(error)}`, `inspect pid ${pid}; retry stop only after confirming it is still this repo's AgentOS daemon`);
    }
  }
  const stopped = await waitUntilStopped(pid, options);
  if (!stopped) {
    return refused(root, pid, `sent SIGTERM to daemon pid ${pid}, but it is still running`, `inspect pid ${pid}; retry stop only after confirming it is still this repo's AgentOS daemon`);
  }
  await cleanupDaemonState(root);
  return {
    action: "stopped",
    repoRoot: root,
    pid,
    message: `stopped AgentOS daemon pid ${pid}`,
    nextSafeAction: nextStartAction
  };
}

export async function restartDaemon(options: DaemonLifecycleOptions = {}): Promise<DaemonLifecycleResult> {
  const stopped = await stopDaemon(options);
  if (stopped.action === "refused") return stopped;
  const started = await startDaemon(options);
  return {
    ...started,
    action: started.action === "started" ? "restarted" : started.action,
    message: started.action === "started" ? `restarted AgentOS daemon for ${started.repoRoot}` : started.message
  };
}

export function formatDaemonLifecycleResult(result: DaemonLifecycleResult): string {
  return [`Daemon: ${result.action} - ${result.message}`, result.pid ? `PID: ${result.pid}` : null, `Next safe action: ${result.nextSafeAction}`]
    .filter(Boolean)
    .join("\n");
}

function startRefusal(root: string, workflowPath: string, health: DaemonHealth): DaemonLifecycleResult | null {
  if (health.status === "healthy" || health.status === "blocked_preflight" || health.status === "stale_freshness") {
    return refused(
      root,
      health.pid,
      `daemon already has a verified live AgentOS process: ${health.message}`,
      `use restart if replacement is intended: ${daemonRestartCommand(root, workflowPath)}`
    );
  }
  if (health.status === "non_agentos_pid") {
    return refused(root, health.pid, `refusing to start daemon because PID state is ambiguous: ${health.message}`, health.nextSafeAction);
  }
  return null;
}

async function cleanupDaemonPidState(root: string, health: DaemonHealth): Promise<void> {
  await cleanupDaemonState(root, health.pidPath);
}

async function cleanupDaemonState(root: string, pidPath = join(root, ".agent-os", "daemon.pid")): Promise<void> {
  await removePath(pidPath);
  await removePath(daemonIdentityPath(root));
}

async function waitUntilStopped(pid: number, options: DaemonLifecycleOptions): Promise<boolean> {
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const timeoutMs = options.waitForStopMs ?? 10_000;
  const pollMs = options.pollIntervalMs ?? 100;
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (!isAlive(pid)) return true;
    await sleep(pollMs);
  }
  return !isAlive(pid);
}

function daemonShellScript(root: string, workflowPath: string, startGitSha: string): string {
  return [
    `cd ${shellQuote(root)}`,
    "mkdir -p .agent-os",
    "echo $$ > .agent-os/daemon.pid",
    `export ${DAEMON_LOG_ENV}=${shellQuote(".agent-os/daemon.log")}`,
    `export ${DAEMON_START_GIT_SHA_ENV}=${shellQuote(startGitSha)}`,
    `exec bin/agent-os orchestrator run --repo . --workflow ${shellQuote(workflowPath)} >> .agent-os/daemon.log 2>&1`
  ].join(" && ");
}

function spawnDaemonShell(script: string, env: NodeJS.ProcessEnv): { pid?: number; unref?: () => void } {
  return spawn("bash", ["-lc", script], {
    detached: true,
    env,
    stdio: "ignore"
  });
}

async function resolveStartGitSha(root: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolveSha) => {
    execFile("git", ["rev-parse", "HEAD"], { cwd: root }, (error, stdout) => {
      resolveSha(error ? "unknown" : stdout.trim() || "unknown");
    });
  });
}

function refused(repoRoot: string, pid: number | null, message: string, nextSafeAction: string): DaemonLifecycleResult {
  return {
    action: "refused",
    repoRoot,
    pid,
    message,
    nextSafeAction
  };
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
