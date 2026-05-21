import { join, resolve } from "node:path";
import { exists, readText, writeTextAtomicEnsuringDir } from "./fs-utils.js";
import { redactText } from "./redaction.js";

export const DAEMON_IDENTITY_SCHEMA_VERSION = 1;
export const DAEMON_IDENTITY_RELATIVE_PATH = join(".agent-os", "state", "daemon-identity.json");

export interface DaemonIdentity {
  schemaVersion: 1;
  repoRoot: string;
  pid: number;
  startedAt: string;
  startGitSha: string;
}

export type DaemonIdentityStatus = "active" | "missing" | "invalid" | "stale";

export interface DaemonIdentityReadResult {
  status: DaemonIdentityStatus;
  path: string;
  identity: DaemonIdentity | null;
  message: string;
}

export interface WriteDaemonIdentityOptions {
  pid?: number;
  startedAt?: Date | string;
  startGitSha?: string | null;
}

export interface ReadDaemonIdentityOptions {
  isProcessAlive?: (pid: number) => boolean;
}

export async function writeDaemonIdentity(repoRoot = process.cwd(), options: WriteDaemonIdentityOptions = {}): Promise<DaemonIdentity> {
  const identity = daemonIdentity(repoRoot, options);
  await writeTextAtomicEnsuringDir(daemonIdentityPath(repoRoot), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

export async function readDaemonIdentity(repoRoot = process.cwd(), options: ReadDaemonIdentityOptions = {}): Promise<DaemonIdentityReadResult> {
  const path = daemonIdentityPath(repoRoot);
  if (!(await exists(path))) {
    return {
      status: "missing",
      path,
      identity: null,
      message: "daemon identity metadata is missing"
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(path));
  } catch (error) {
    return {
      status: "invalid",
      path,
      identity: null,
      message: `daemon identity metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const normalized = normalizeDaemonIdentity(parsed);
  if (!normalized) {
    return {
      status: "invalid",
      path,
      identity: null,
      message: "daemon identity metadata is missing required fields"
    };
  }
  if (normalized.repoRoot !== resolve(repoRoot)) {
    return {
      status: "invalid",
      path,
      identity: normalized,
      message: `daemon identity repoRoot does not match ${resolve(repoRoot)}`
    };
  }

  const alive = (options.isProcessAlive ?? isProcessAlive)(normalized.pid);
  if (!alive) {
    return {
      status: "stale",
      path,
      identity: normalized,
      message: `daemon identity pid ${normalized.pid} is not running`
    };
  }

  return {
    status: "active",
    path,
    identity: normalized,
    message: "daemon identity pid is running"
  };
}

export function daemonIdentityPath(repoRoot = process.cwd()): string {
  return join(resolve(repoRoot), DAEMON_IDENTITY_RELATIVE_PATH);
}

function daemonIdentity(repoRoot: string, options: WriteDaemonIdentityOptions): DaemonIdentity {
  return {
    schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
    repoRoot: resolve(repoRoot),
    pid: positivePid(options.pid ?? process.pid),
    startedAt: isoTimestamp(options.startedAt),
    startGitSha: safeString(options.startGitSha)
  };
}

function normalizeDaemonIdentity(value: unknown): DaemonIdentity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<DaemonIdentity>;
  const pid = raw.pid;
  if (raw.schemaVersion !== DAEMON_IDENTITY_SCHEMA_VERSION) return null;
  if (typeof raw.repoRoot !== "string" || raw.repoRoot.trim() === "") return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof raw.startedAt !== "string" || Number.isNaN(Date.parse(raw.startedAt))) return null;
  if (typeof raw.startGitSha !== "string" || raw.startGitSha.trim() === "") return null;
  return {
    schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
    repoRoot: resolve(raw.repoRoot),
    pid,
    startedAt: new Date(raw.startedAt).toISOString(),
    startGitSha: safeString(raw.startGitSha)
  };
}

function positivePid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`daemon identity pid must be a positive integer: ${pid}`);
  return pid;
}

function isoTimestamp(value: Date | string | undefined): string {
  if (value == null) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`daemon identity startedAt must be a valid date: ${String(value)}`);
  return date.toISOString();
}

function safeString(value: string | null | undefined): string {
  const redacted = redactText(value ?? "unknown").trim().replace(/\s+/g, "_");
  return redacted || "unknown";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
