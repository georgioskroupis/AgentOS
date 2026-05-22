import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensureDir, exists, removePath } from "./fs-utils.js";
import type { ServiceConfig, Workspace } from "./types.js";

export const WORKSPACE_LOCK_SCHEMA_VERSION = 1;
export const WORKSPACE_BOOTSTRAP_SCHEMA_VERSION = 1;
const workspaceLockStaleMs = 24 * 60 * 60 * 1000;

export function workspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class WorkspaceManager {
  private readonly sourceRepoPath: string;
  private readonly workspaceRoot: string;

  constructor(
    private readonly config: ServiceConfig,
    sourceRepo: string
  ) {
    this.sourceRepoPath = resolve(sourceRepo);
    this.workspaceRoot = resolve(config.workspace.root);
  }

  async createOrReuse(identifier: string): Promise<Workspace> {
    await ensureDir(this.workspaceRoot);
    const key = workspaceKey(identifier);
    const path = join(this.workspaceRoot, key);
    const markerPath = workspaceBootstrapMarkerPath(this.sourceRepoPath, key);
    const lockPath = await acquireWorkspaceLock(this.workspaceRoot, key, path);
    try {
      const markerExists = await exists(markerPath);
      const marker = await readWorkspaceBootstrapMarker(markerPath);
      const validMarker = validWorkspaceBootstrapMarker(marker, {
        key,
        path,
        root: this.workspaceRoot,
        sourceRepo: this.sourceRepoPath,
        afterCreate: this.config.hooks.afterCreate,
        timeoutMs: this.config.hooks.timeoutMs
      });
      const directoryExists = await exists(path);
      if (validMarker && directoryExists) {
        return { path, workspaceKey: key, createdNow: false, lockPath };
      }
      if (markerExists && !directoryExists) {
        await removePath(markerPath);
      }
      if (directoryExists && !(await isDirectoryEmpty(path))) {
        if (!this.config.hooks.afterCreate) {
          await writeWorkspaceBootstrapMarker(markerPath, workspaceBootstrapMarker(key, path, this.workspaceRoot, this.sourceRepoPath, this.config.hooks.afterCreate, this.config.hooks.timeoutMs));
          return { path, workspaceKey: key, createdNow: false, lockPath };
        }
        throw new Error(
          `workspace_partial_bootstrap: workspace exists without a valid bootstrap marker and is not empty. Safe next action: inspect or remove ${path}, then retry.`
        );
      }
      await ensureDir(path);
      if (this.config.hooks.afterCreate) {
        await runHook(this.config.hooks.afterCreate, path, this.config.hooks.timeoutMs, hookEnv(this.sourceRepoPath, path, key));
      }
      await writeWorkspaceBootstrapMarker(markerPath, workspaceBootstrapMarker(key, path, this.workspaceRoot, this.sourceRepoPath, this.config.hooks.afterCreate, this.config.hooks.timeoutMs));
      return { path, workspaceKey: key, createdNow: true, lockPath };
    } catch (error) {
      await releaseWorkspaceLock(lockPath);
      throw error;
    }
  }

  async beforeRun(workspace: Workspace): Promise<void> {
    if (this.config.hooks.beforeRun) {
      const path = resolve(workspace.path);
      await runHook(this.config.hooks.beforeRun, path, this.config.hooks.timeoutMs, hookEnv(this.sourceRepoPath, path, workspace.workspaceKey));
    }
  }

  async afterRun(workspace: Workspace): Promise<void> {
    const path = resolve(workspace.path);
    if (this.config.hooks.afterRun) {
      await runHook(this.config.hooks.afterRun, path, this.config.hooks.timeoutMs, hookEnv(this.sourceRepoPath, path, workspace.workspaceKey)).catch(() => undefined);
    }
    if (workspace.lockPath) await releaseWorkspaceLock(workspace.lockPath);
  }

  async remove(identifier: string): Promise<void> {
    const key = workspaceKey(identifier);
    const path = join(this.workspaceRoot, key);
    const markerPath = workspaceBootstrapMarkerPath(this.sourceRepoPath, key);
    const lockPath = await acquireWorkspaceLock(this.workspaceRoot, key, path);
    try {
      if (await exists(path)) {
        if (this.config.hooks.beforeRemove) {
          await runHook(this.config.hooks.beforeRemove, path, this.config.hooks.timeoutMs, hookEnv(this.sourceRepoPath, path, key)).catch(() => undefined);
        }
        const removedWorktree = await removeGitWorktreeIfRegistered(this.sourceRepoPath, path);
        if (!removedWorktree) await removePath(path);
      }
      await removePath(markerPath);
    } finally {
      await releaseWorkspaceLock(lockPath);
    }
  }
}

export async function acquireWorkspaceLock(root: string, key: string, workspacePath: string): Promise<string> {
  const lockRoot = join(root, ".agent-os", "locks", "workspaces");
  await ensureDir(lockRoot);
  const lockPath = join(lockRoot, `${key}.lock`);
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    if (!(await recoverStaleWorkspaceLock(lockPath))) {
      throw new Error(`workspace_locked: ${key}`);
    }
    await mkdir(lockPath);
  }
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify(
      {
        schemaVersion: WORKSPACE_LOCK_SCHEMA_VERSION,
        workspaceKey: key,
        workspacePath,
        pid: process.pid,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return lockPath;
}

export async function releaseWorkspaceLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
}

export interface WorkspaceBootstrapMarker {
  schemaVersion: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceRoot: string;
  sourceRepo: string;
  hookCommandHash: string;
  hookTimeoutMs: number;
  initializedAt: string;
}

export function workspaceBootstrapMarkerPath(sourceRepo: string, key: string): string {
  return join(resolve(sourceRepo), ".agent-os", "state", "workspaces", `${key}.json`);
}

export function workspaceBootstrapHookHash(command: string | null): string {
  return `sha256:${createHash("sha256").update(command ?? "").digest("hex")}`;
}

export interface WorkspaceLockRecovery {
  lockPath: string;
  workspaceKey: string;
  recovered: boolean;
  reason: string;
}

export async function recoverWorkspaceLocks(root: string): Promise<WorkspaceLockRecovery[]> {
  const lockRoot = join(root, ".agent-os", "locks", "workspaces");
  if (!(await exists(lockRoot))) return [];
  const entries = await readdir(lockRoot, { withFileTypes: true });
  const recoveries: WorkspaceLockRecovery[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lock")) continue;
    const lockPath = join(lockRoot, entry.name);
    const owner = await readLockOwner(lockPath);
    const workspaceKey = entry.name.slice(0, -".lock".length);
    const reason = staleWorkspaceLockReason(owner);
    if (reason) {
      await releaseWorkspaceLock(lockPath);
      recoveries.push({ lockPath, workspaceKey, recovered: true, reason });
    } else {
      recoveries.push({ lockPath, workspaceKey, recovered: false, reason: "lock owner is still active" });
    }
  }
  return recoveries;
}

export async function runHook(script: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-lc", script], { cwd, stdio: "pipe", env });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`hook_timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`hook_failed exit=${code}: ${stderr.trim()}`));
      }
    });
  });
}

function hookEnv(sourceRepo: string, workspacePath: string, key: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_OS_SOURCE_REPO: sourceRepo,
    AGENT_OS_WORKSPACE: workspacePath,
    AGENT_OS_WORKSPACE_KEY: key
  };
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
  }
}

async function readWorkspaceBootstrapMarker(path: string): Promise<WorkspaceBootstrapMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0,
      workspaceKey: typeof parsed.workspaceKey === "string" ? parsed.workspaceKey : "",
      workspacePath: typeof parsed.workspacePath === "string" ? parsed.workspacePath : "",
      workspaceRoot: typeof parsed.workspaceRoot === "string" ? parsed.workspaceRoot : "",
      sourceRepo: typeof parsed.sourceRepo === "string" ? parsed.sourceRepo : "",
      hookCommandHash: typeof parsed.hookCommandHash === "string" ? parsed.hookCommandHash : "",
      hookTimeoutMs: typeof parsed.hookTimeoutMs === "number" ? parsed.hookTimeoutMs : 0,
      initializedAt: typeof parsed.initializedAt === "string" ? parsed.initializedAt : ""
    };
  } catch {
    return null;
  }
}

async function writeWorkspaceBootstrapMarker(path: string, marker: WorkspaceBootstrapMarker): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function validWorkspaceBootstrapMarker(
  marker: WorkspaceBootstrapMarker | null,
  expected: { key: string; path: string; root: string; sourceRepo: string; afterCreate: string | null; timeoutMs: number }
): boolean {
  return Boolean(
    marker &&
      marker.schemaVersion === WORKSPACE_BOOTSTRAP_SCHEMA_VERSION &&
      marker.workspaceKey === expected.key &&
      resolve(marker.workspacePath) === expected.path &&
      resolve(marker.workspaceRoot) === expected.root &&
      resolve(marker.sourceRepo) === expected.sourceRepo &&
      marker.hookCommandHash === workspaceBootstrapHookHash(expected.afterCreate) &&
      marker.hookTimeoutMs === expected.timeoutMs
  );
}

function workspaceBootstrapMarker(key: string, path: string, root: string, sourceRepo: string, afterCreate: string | null, timeoutMs: number): WorkspaceBootstrapMarker {
  return {
    schemaVersion: WORKSPACE_BOOTSTRAP_SCHEMA_VERSION,
    workspaceKey: key,
    workspacePath: path,
    workspaceRoot: root,
    sourceRepo,
    hookCommandHash: workspaceBootstrapHookHash(afterCreate),
    hookTimeoutMs: timeoutMs,
    initializedAt: new Date().toISOString()
  };
}

async function recoverStaleWorkspaceLock(lockPath: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (staleWorkspaceLockReason(owner)) {
    await releaseWorkspaceLock(lockPath);
    return true;
  }
  return false;
}

function staleWorkspaceLockReason(owner: { pid?: number; createdAt: string } | null): string | null {
  if (!owner) return "lock owner metadata is missing or unreadable";
  const ageMs = Date.now() - Date.parse(owner.createdAt);
  if (!Number.isFinite(ageMs)) return "lock owner metadata has an invalid timestamp";
  if (Number.isFinite(ageMs) && ageMs > workspaceLockStaleMs) return "lock owner is older than stale threshold";
  if (owner.pid && !isProcessAlive(owner.pid)) return `lock owner pid ${owner.pid} is not running`;
  return null;
}

async function readLockOwner(lockPath: string): Promise<{ pid?: number; createdAt: string } | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
    };
  } catch {
    return null;
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

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function removeGitWorktreeIfRegistered(sourceRepo: string, workspacePath: string): Promise<boolean> {
  const listed = await runCommand("git", ["-C", sourceRepo, "worktree", "list", "--porcelain"], sourceRepo).catch(() => null);
  if (!listed) return false;
  const target = resolve(workspacePath);
  const registered = listed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length).trim()))
    .some((path) => path === target);
  if (!registered) return false;
  await runCommand("git", ["-C", sourceRepo, "worktree", "remove", "--force", workspacePath], sourceRepo);
  return true;
}

function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} failed`));
    });
  });
}
