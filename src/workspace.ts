import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureDir, exists, removePath } from "./fs-utils.js";
import type { ServiceConfig, Workspace } from "./types.js";

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
    const createdNow = !(await exists(path));
    if (createdNow && this.config.hooks.afterCreate) {
      await runHook(this.config.hooks.afterCreate, this.sourceRepo, this.config.hooks.timeoutMs, hookEnv(this.sourceRepo, path, key));
    }
    await ensureDir(path);
    return { path, workspaceKey: key, createdNow };
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
  }

  async remove(identifier: string): Promise<void> {
    const path = join(this.config.workspace.root, workspaceKey(identifier));
    if (await exists(path)) {
      if (this.config.hooks.beforeRemove) {
        await runHook(this.config.hooks.beforeRemove, this.sourceRepo, this.config.hooks.timeoutMs, hookEnv(this.sourceRepo, path, workspaceKey(identifier))).catch(() => undefined);
      }
      await removePath(path);
    }
  }
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
