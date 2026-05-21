import { access, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DAEMON_LOG_ENV, DAEMON_START_GIT_SHA_ENV } from "./daemon-log.js";
import { RuntimeStateStore } from "./runtime-state.js";

export type DaemonHealthStatus = "healthy" | "blocked_preflight" | "stale_freshness" | "stopped" | "stale_pid" | "failed_launch";

export interface DaemonHealth {
  status: DaemonHealthStatus;
  pid: number | null;
  pidPath: string;
  logPath: string;
  message: string;
  nextSafeAction: string;
}

export async function inspectDaemonHealth(repoRoot = process.cwd()): Promise<DaemonHealth> {
  const root = resolve(repoRoot);
  const pidPath = join(root, ".agent-os", "daemon.pid");
  const logPath = join(root, ".agent-os", "daemon.log");
  const pid = await readPid(pidPath);
  const launchCommand = daemonLaunchCommand(root);
  if (!pid) {
    return {
      status: "stopped",
      pid: null,
      pidPath,
      logPath,
      message: "no daemon PID file is present",
      nextSafeAction: launchCommand
    };
  }

  const alive = isProcessAlive(pid);
  const logSize = await fileSize(logPath);
  if (!alive) {
    const failedEmptyLog = logSize === 0;
    return {
      status: failedEmptyLog ? "failed_launch" : "stale_pid",
      pid,
      pidPath,
      logPath,
      message: failedEmptyLog ? `pid ${pid} is not running and ${logPath} is empty` : `pid ${pid} is not running`,
      nextSafeAction: `remove ${pidPath}, inspect ${logPath || ".agent-os/daemon.log"}, then restart with: ${launchCommand}`
    };
  }

  const runtime = await new RuntimeStateStore(root).read();
  if (runtime.daemon?.preflightStatus && runtime.daemon.preflightStatus !== "ready") {
    const githubAuthMissing = runtime.daemon.credentialPreflight?.github.auth === "missing";
    return {
      status: "blocked_preflight",
      pid,
      pidPath,
      logPath,
      message: runtime.daemon.preflightMessage ?? runtime.daemon.preflightStatus,
      nextSafeAction: githubAuthMissing
        ? `run gh auth status for the configured github.command, then authenticate and restart the daemon with: ${launchCommand}`
        : runtime.daemon.repoEnvPath
        ? `fix ${runtime.daemon.repoEnvPath}, then restart the daemon with: ${launchCommand}`
        : `provide required environment, then restart the daemon with: ${launchCommand}`
    };
  }

  if (runtime.daemon?.freshnessStatus === "stale" || runtime.daemon?.freshnessStatus === "main_advanced") {
    return {
      status: "stale_freshness",
      pid,
      pidPath,
      logPath,
      message: runtime.daemon.freshnessMessage ?? "daemon base branch advanced after this process started",
      nextSafeAction: "run git pull && bin/agent-os daemon restart"
    };
  }

  return {
    status: "healthy",
    pid,
    pidPath,
    logPath,
    message: runtime.daemon?.preflightStatus === "ready" ? "daemon process is alive and credential preflight is ready" : "daemon process is alive",
    nextSafeAction: "no operator action required; use `agent-os status --registry` or `agent-os inspect <issue>` for work-level progress"
  };
}

export function daemonLaunchCommand(repoRoot = process.cwd(), workflowPath = "WORKFLOW.md"): string {
  const root = resolve(repoRoot);
  const session = `agent-os-${basename(root).replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const daemonScript = [
    `cd ${shellQuote(root)}`,
    "mkdir -p .agent-os",
    "echo $$ > .agent-os/daemon.pid",
    `export ${DAEMON_LOG_ENV}=${shellQuote(".agent-os/daemon.log")}`,
    `${DAEMON_START_GIT_SHA_ENV}=$(git rev-parse HEAD 2>/dev/null || printf unknown)`,
    `export ${DAEMON_START_GIT_SHA_ENV}`,
    `exec bin/agent-os orchestrator run --repo . --workflow ${shellQuote(workflowPath)} >> .agent-os/daemon.log 2>&1`
  ].join(" && ");
  return [
    "mkdir -p .agent-os &&",
    `screen -dmS ${shellQuote(session)}`,
    "bash -lc",
    shellQuote(daemonScript)
  ].join(" ");
}

async function readPid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return (await exists(path)) ? 0 : null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
