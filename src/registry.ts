import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { ensureDir, exists, readText, writeTextAtomicEnsuringDir, writeTextEnsuringDir } from "./fs-utils.js";
import type { HarnessProfile, ProjectConfig, ProjectRegistry } from "./types.js";

export const registryFileName = "agent-os.yml";
export const REGISTRY_STATE_SCHEMA_VERSION = 1;
export const REGISTRY_PROJECT_LOCK_SCHEMA_VERSION = 1;

export type RegistryProjectStatus =
  | "idle"
  | "dispatched"
  | "global_capacity_exhausted"
  | "project_capacity_exhausted"
  | "locked"
  | "transient_tracker_error"
  | "failed";

export interface RegistryProjectPaths {
  name: string;
  repoRoot: string;
  workflowPath: string;
  workflowRelativePath: string;
}

export interface RegistryProjectSummary {
  name: string;
  repoRoot: string;
  workflowPath: string;
  status: RegistryProjectStatus;
  checkedAt: string;
  activeRuns: number;
  retryQueue: number;
  claimedIssues: number;
  maxConcurrency: number;
  configuredMaxConcurrentAgents?: number;
  dispatched?: number;
  candidates?: number;
  lastSuccessfulTrackerReadAt?: string;
  lastError?: string;
  errorCategory?: "tracker_network" | "project_lock" | "orchestrator";
  trustMode?: string;
  lifecycleMode?: string;
  automationProfile?: string;
  automationRepairPolicy?: string;
  daemonFreshnessStatus?: string;
  daemonFreshnessMessage?: string | null;
}

export interface RegistryRuntimeState {
  schemaVersion: 1;
  updatedAt: string;
  cursor: number;
  globalConcurrency: number;
  projects: RegistryProjectSummary[];
}

export async function loadRegistry(path = registryFileName): Promise<ProjectRegistry> {
  const resolved = resolve(path);
  if (!(await exists(resolved))) {
    return {
      version: 1,
      defaults: {
        prProvider: "github",
        workspaceRoot: ".agent-os/workspaces",
        maxConcurrency: 1
      },
      projects: []
    };
  }
  const parsed = YAML.parse(await readText(resolved)) as ProjectRegistry | null;
  return {
    version: 1,
    defaults: {
      prProvider: parsed?.defaults?.prProvider ?? "github",
      workspaceRoot: parsed?.defaults?.workspaceRoot ?? ".agent-os/workspaces",
      maxConcurrency: positiveInt(parsed?.defaults?.maxConcurrency, 1),
      ...(positiveInt(parsed?.defaults?.pollingIntervalMs, 0) > 0 ? { pollingIntervalMs: positiveInt(parsed?.defaults?.pollingIntervalMs, 0) } : {})
    },
    projects: (parsed?.projects ?? []).map(normalizeProjectConfig)
  };
}

export async function saveRegistry(registry: ProjectRegistry, path = registryFileName): Promise<void> {
  await writeTextEnsuringDir(resolve(path), YAML.stringify(registry));
}

export async function addProject(input: {
  name: string;
  repo: string;
  workflow?: string;
  harnessProfile?: HarnessProfile;
  projectSlug?: string;
  maxConcurrency?: number;
  registryPath?: string;
}): Promise<ProjectRegistry> {
  const registry = await loadRegistry(input.registryPath);
  const nextProject: ProjectConfig = {
    name: input.name,
    repo: input.repo,
    workflow: input.workflow ?? "WORKFLOW.md",
    harnessProfile: input.harnessProfile ?? "base",
    tracker: input.projectSlug ? { kind: "linear", projectSlug: input.projectSlug } : undefined,
    maxConcurrency: positiveInt(input.maxConcurrency, 1)
  };
  registry.projects = registry.projects.filter((project) => project.name !== input.name);
  registry.projects.push(nextProject);
  await saveRegistry(registry, input.registryPath);
  return registry;
}

export async function removeProject(name: string, registryPath?: string): Promise<ProjectRegistry> {
  const registry = await loadRegistry(registryPath);
  registry.projects = registry.projects.filter((project) => project.name !== name);
  await saveRegistry(registry, registryPath);
  return registry;
}

export function resolveRegistryProjectPaths(project: ProjectConfig, registryPath = registryFileName): RegistryProjectPaths {
  const baseDir = dirname(resolve(registryPath));
  const repoRoot = isAbsolute(project.repo) ? resolve(project.repo) : resolve(baseDir, project.repo);
  const workflowRelativePath = project.workflow ?? "WORKFLOW.md";
  const workflowPath = isAbsolute(workflowRelativePath) ? resolve(workflowRelativePath) : resolve(repoRoot, workflowRelativePath);
  return {
    name: project.name,
    repoRoot,
    workflowPath,
    workflowRelativePath
  };
}

export class RegistryStateStore {
  constructor(private readonly registryPath = registryFileName) {}

  async read(): Promise<RegistryRuntimeState> {
    if (!(await exists(this.path()))) return emptyRegistryState();
    const parsed = JSON.parse(await readText(this.path())) as Partial<RegistryRuntimeState>;
    return normalizeRegistryState(parsed);
  }

  async write(state: RegistryRuntimeState): Promise<void> {
    await writeTextAtomicEnsuringDir(this.path(), `${JSON.stringify(normalizeRegistryState(state), null, 2)}\n`);
  }

  async update(mutator: (state: RegistryRuntimeState) => void): Promise<RegistryRuntimeState> {
    const state = await this.read();
    mutator(state);
    state.updatedAt = new Date().toISOString();
    const normalized = normalizeRegistryState(state);
    await this.write(normalized);
    return normalized;
  }

  path(): string {
    return join(dirname(resolve(this.registryPath)), ".agent-os", "state", "registry.json");
  }
}

export async function acquireProjectRunnerLock(repoRoot: string, owner = "registry"): Promise<string> {
  const lockRoot = join(repoRoot, ".agent-os", "locks", "registry");
  await ensureDir(lockRoot);
  const lockPath = join(lockRoot, "project-runner.lock");
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    if (!(await recoverProjectRunnerLock(lockPath))) {
      throw new Error("project_registry_locked");
    }
    await mkdir(lockPath);
  }
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify(
      {
        schemaVersion: REGISTRY_PROJECT_LOCK_SCHEMA_VERSION,
        owner,
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

export async function releaseProjectRunnerLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true });
}

function emptyRegistryState(): RegistryRuntimeState {
  return {
    schemaVersion: REGISTRY_STATE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    cursor: 0,
    globalConcurrency: 1,
    projects: []
  };
}

function normalizeRegistryState(raw: Partial<RegistryRuntimeState>): RegistryRuntimeState {
  const fallback = emptyRegistryState();
  return {
    schemaVersion: REGISTRY_STATE_SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : fallback.updatedAt,
    cursor: Number.isInteger(raw.cursor) && raw.cursor! >= 0 ? raw.cursor! : 0,
    globalConcurrency: positiveInt(raw.globalConcurrency, 1),
    projects: Array.isArray(raw.projects) ? raw.projects.filter((project) => project?.name).map(normalizeProjectSummary) : []
  };
}

function normalizeProjectSummary(raw: RegistryProjectSummary): RegistryProjectSummary {
  return {
    name: raw.name,
    repoRoot: raw.repoRoot,
    workflowPath: raw.workflowPath,
    status: raw.status ?? "idle",
    checkedAt: raw.checkedAt ?? new Date().toISOString(),
    activeRuns: nonNegativeInt(raw.activeRuns, 0),
    retryQueue: nonNegativeInt(raw.retryQueue, 0),
    claimedIssues: nonNegativeInt(raw.claimedIssues, 0),
    maxConcurrency: positiveInt(raw.maxConcurrency, 1),
    ...(raw.configuredMaxConcurrentAgents != null ? { configuredMaxConcurrentAgents: positiveInt(raw.configuredMaxConcurrentAgents, 1) } : {}),
    ...(raw.dispatched != null ? { dispatched: nonNegativeInt(raw.dispatched, 0) } : {}),
    ...(raw.candidates != null ? { candidates: nonNegativeInt(raw.candidates, 0) } : {}),
    ...(raw.lastSuccessfulTrackerReadAt ? { lastSuccessfulTrackerReadAt: raw.lastSuccessfulTrackerReadAt } : {}),
    ...(raw.lastError ? { lastError: raw.lastError } : {}),
    ...(raw.errorCategory ? { errorCategory: raw.errorCategory } : {}),
    ...(raw.trustMode ? { trustMode: raw.trustMode } : {}),
    ...(raw.lifecycleMode ? { lifecycleMode: raw.lifecycleMode } : {}),
    ...(raw.automationProfile ? { automationProfile: raw.automationProfile } : {}),
    ...(raw.automationRepairPolicy ? { automationRepairPolicy: raw.automationRepairPolicy } : {}),
    ...(raw.daemonFreshnessStatus ? { daemonFreshnessStatus: raw.daemonFreshnessStatus } : {}),
    ...(raw.daemonFreshnessMessage !== undefined ? { daemonFreshnessMessage: raw.daemonFreshnessMessage } : {})
  };
}

function normalizeProjectConfig(project: ProjectConfig): ProjectConfig {
  return {
    name: project.name,
    repo: project.repo,
    workflow: project.workflow ?? "WORKFLOW.md",
    harnessProfile: project.harnessProfile,
    tracker: project.tracker,
    maxConcurrency: positiveInt(project.maxConcurrency, 1)
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function recoverProjectRunnerLock(lockPath: string): Promise<boolean> {
  const owner = await readProjectLockOwner(lockPath);
  const reason = staleProjectLockReason(owner);
  if (!reason) return false;
  await releaseProjectRunnerLock(lockPath);
  return true;
}

async function readProjectLockOwner(lockPath: string): Promise<{ pid?: number; createdAt: string } | null> {
  try {
    const parsed = JSON.parse(await readText(join(lockPath, "owner.json"))) as Record<string, unknown>;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
    };
  } catch {
    return null;
  }
}

function staleProjectLockReason(owner: { pid?: number; createdAt: string } | null): string | null {
  if (!owner) return "lock owner metadata is missing or unreadable";
  const ageMs = Date.now() - Date.parse(owner.createdAt);
  if (!Number.isFinite(ageMs)) return "lock owner metadata has an invalid timestamp";
  if (ageMs > 24 * 60 * 60 * 1000) return "lock owner is older than stale threshold";
  if (owner.pid && !isProcessAlive(owner.pid)) return `lock owner pid ${owner.pid} is not running`;
  return null;
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
