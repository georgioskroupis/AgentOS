import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DAEMON_LOG_ENV = "AGENT_OS_DAEMON_LOG";
export const DAEMON_START_GIT_SHA_ENV = "AGENT_OS_DAEMON_START_GIT_SHA";

export interface DaemonLogRuntime {
  logPath: string;
  startGitSha: string;
}

interface DaemonMarkerOptions {
  now?: Date;
  pid?: number;
}

interface DaemonLaunchMarkerOptions extends DaemonMarkerOptions {
  startGitSha?: string;
}

export type DaemonCrashKind = "uncaughtException" | "unhandledRejection";

export function daemonLogRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env): DaemonLogRuntime | null {
  const logPath = env[DAEMON_LOG_ENV]?.trim();
  if (!logPath) return null;
  return {
    logPath,
    startGitSha: markerValue(env[DAEMON_START_GIT_SHA_ENV])
  };
}

export function formatDaemonLaunchMarker(options: DaemonLaunchMarkerOptions = {}): string {
  return `==== agent-os orchestrator launched at ${timestamp(options.now)} pid=${options.pid ?? process.pid} startGitSha=${markerValue(options.startGitSha)} ====`;
}

export function formatDaemonStopMarker(options: DaemonMarkerOptions = {}): string {
  return `==== agent-os orchestrator stopped cleanly at ${timestamp(options.now)} ====`;
}

export function formatDaemonCrashTrace(error: unknown, kind: DaemonCrashKind = "uncaughtException", options: DaemonMarkerOptions = {}): string {
  return [`==== agent-os orchestrator ${kind} at ${timestamp(options.now)} pid=${options.pid ?? process.pid} ====`, errorTrace(error)].join("\n");
}

export function appendDaemonLaunchMarker(logPath: string, options: DaemonLaunchMarkerOptions = {}): void {
  appendDaemonLog(logPath, formatDaemonLaunchMarker(options));
}

export function appendDaemonStopMarker(logPath: string, options: DaemonMarkerOptions = {}): void {
  appendDaemonLog(logPath, formatDaemonStopMarker(options));
}

export function installDaemonCrashCapture(logPath: string): () => void {
  let captured = false;
  const capture = (kind: DaemonCrashKind, error: unknown): void => {
    if (captured) return;
    captured = true;
    try {
      appendDaemonLog(logPath, formatDaemonCrashTrace(error, kind));
    } catch (appendError) {
      process.stderr.write(`${formatDaemonCrashTrace(error, kind)}\n`);
      process.stderr.write(`daemon_log_capture_failed: ${appendError instanceof Error ? appendError.message : String(appendError)}\n`);
    }
    process.exitCode = 1;
    process.exit(1);
  };
  const uncaughtException = (error: Error): void => capture("uncaughtException", error);
  const unhandledRejection = (reason: unknown): void => capture("unhandledRejection", reason);
  process.on("uncaughtException", uncaughtException);
  process.on("unhandledRejection", unhandledRejection);
  return () => {
    process.off("uncaughtException", uncaughtException);
    process.off("unhandledRejection", unhandledRejection);
  };
}

function appendDaemonLog(logPath: string, message: string): void {
  const resolved = resolve(logPath);
  mkdirSync(dirname(resolved), { recursive: true });
  appendFileSync(resolved, `${message.trimEnd()}\n`, "utf8");
}

function timestamp(now: Date | undefined): string {
  return (now ?? new Date()).toISOString();
}

function markerValue(value: string | undefined): string {
  const normalized = value?.trim().replace(/\s+/g, "_");
  return normalized || "unknown";
}

function errorTrace(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
