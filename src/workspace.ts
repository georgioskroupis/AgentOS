import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureDir, exists, removePath } from "./fs-utils.js";
import type { ServiceConfig, Workspace } from "./types.js";

export const WORKSPACE_LOCK_SCHEMA_VERSION = 1;
const workspaceLockStaleMs = 24 * 60 * 60 * 1000;

export function workspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class WorkspaceManager {
  constructor(
    private readonly config: ServiceConfig,
    private readonly sourceRepo: string
  ) {}

  async createOrReuse(identifier: string): Promise<Workspace> {
    await ensureDir(this.config.workspace.root);
    const key = workspaceKey(identifier);
    const path = join(this.config.workspace.root, key);
    const lockPath = await acquireWorkspaceLock(this.config.workspace.root, key, path);
    try {
      const createdNow = !(await exists(path));
      if (createdNow && this.config.hooks.afterCreate) {
        await runHook(this.config.hooks.afterCreate, this.sourceRepo, this.config.hooks.timeoutMs, hookEnv(this.sourceRepo, path, key));
      }
      await ensureDir(path);
      return { path, workspaceKey: key, createdNow, lockPath };
    } catch (error) {
      await releaseWorkspaceLock(lockPath);
      throw error;
    }
  }

  async beforeRun(workspace: Workspace): Promise<void> {
    if (this.config.hooks.beforeRun) {
      await runHook(this.config.hooks.beforeRun, workspace.path, this.config.hooks.timeoutMs, hookEnv(this.sourceRepo, workspace.path, workspace.workspaceKey));
    }
  }

  async afterRun(workspace: Workspace): Promise<void> {
    if (this.config.hooks.afterRun) {
      await runHook(this.config.hooks.afterRun, workspace.path, this.config.hooks.timeoutMs, hookEnv(this.sourceRepo, workspace.path, workspace.workspaceKey)).catch(() => undefined);
    }
    if (workspace.lockPath) await releaseWorkspaceLock(workspace.lockPath);
  }

  async remove(identifier: string): Promise<void> {
    const key = workspaceKey(identifier);
    const path = join(this.config.workspace.root, key);
    const lockPath = await acquireWorkspaceLock(this.config.workspace.root, key, path);
    try {
      if (await exists(path)) {
        if (this.config.hooks.beforeRemove) {
          await runHook(this.config.hooks.beforeRemove, this.sourceRepo, this.config.hooks.timeoutMs, hookEnv(this.sourceRepo, path, key)).catch(() => undefined);
        }
        const removedWorktree = await removeGitWorktreeIfRegistered(this.sourceRepo, path);
        if (!removedWorktree) await removePath(path);
      }
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
