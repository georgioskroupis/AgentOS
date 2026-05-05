import { setTimeout as sleep } from "node:timers/promises";
import {
  acquireProjectRunnerLock,
  loadRegistry,
  RegistryStateStore,
  releaseProjectRunnerLock,
  resolveRegistryProjectPaths,
  type RegistryProjectSummary,
  type RegistryRuntimeState
} from "./registry.js";
import { Orchestrator, type OrchestratorRunOptions, type OrchestratorRunSummary } from "./orchestrator.js";
import { resolveRepoEnv } from "./env.js";
import { RuntimeStateStore, type RuntimeState } from "./runtime-state.js";
import { loadWorkflow, resolveServiceConfig } from "./workflow.js";
import type { ProjectConfig, ServiceConfig } from "./types.js";

export interface RegistryOrchestratorOptions {
  registryPath?: string;
  maxConcurrency?: number;
  pollingIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  createProjectOrchestrator?: (context: RegistryProjectContext) => ProjectOrchestrator;
}

export interface RegistryProjectContext {
  project: ProjectConfig;
  name: string;
  repoRoot: string;
  workflowPath: string;
  maxConcurrency: number;
  config: ServiceConfig;
}

export interface ProjectOrchestrator {
  runOnce(waitForWorkers?: boolean, options?: OrchestratorRunOptions): Promise<Partial<OrchestratorRunSummary> | void>;
}

export interface RegistryRunResult {
  state: RegistryRuntimeState;
  summaries: RegistryProjectSummary[];
}

export class RegistryOrchestrator {
  private readonly registryPath: string;
  private readonly stateStore: RegistryStateStore;
  private readonly heldLocks = new Map<string, { contextKey: string; lockPath: string }>();
  private readonly orchestrators = new Map<string, { contextKey: string; orchestrator: ProjectOrchestrator }>();

  constructor(private readonly options: RegistryOrchestratorOptions = {}) {
    this.registryPath = options.registryPath ?? "agent-os.yml";
    this.stateStore = new RegistryStateStore(this.registryPath);
  }

  async runOnce(waitForWorkers = true): Promise<RegistryRunResult> {
    return this.runPass(waitForWorkers, true);
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const registry = await loadRegistry(this.registryPath);
        await this.runPass(false, false);
        const intervalMs = positiveInteger(this.options.pollingIntervalMs ?? registry.defaults?.pollingIntervalMs ?? 30_000, "pollingIntervalMs");
        await sleep(intervalMs, undefined, { signal }).catch((error: Error) => {
          if (signal.aborted || error.name === "AbortError") return;
          throw error;
        });
      }
    } finally {
      await this.releaseHeldLocks();
    }
  }

  private async runPass(waitForWorkers: boolean, releaseLocksAfterPass: boolean): Promise<RegistryRunResult> {
    const registry = await loadRegistry(this.registryPath);
    const previous = await this.stateStore.read();
    const globalConcurrency = positiveInteger(this.options.maxConcurrency ?? registry.defaults?.maxConcurrency ?? 1, "maxConcurrency");
    const contexts: RegistryProjectContext[] = [];
    const summaries = new Map<string, RegistryProjectSummary>();
    for (const project of registry.projects) {
      try {
        contexts.push(await this.resolveContext(project));
      } catch (error) {
        const paths = resolveRegistryProjectPaths(project, this.registryPath);
        summaries.set(project.name, {
          name: project.name,
          repoRoot: paths.repoRoot,
          workflowPath: paths.workflowPath,
          status: "failed",
          checkedAt: new Date().toISOString(),
          activeRuns: 0,
          retryQueue: 0,
          claimedIssues: 0,
          maxConcurrency: project.maxConcurrency ?? 1,
          lastError: error instanceof Error ? error.message : String(error),
          errorCategory: "orchestrator"
        });
      }
    }
    const runtimeByProject = new Map<string, RuntimeState>();
    for (const context of contexts) {
      runtimeByProject.set(context.name, await new RuntimeStateStore(context.repoRoot).read());
    }

    await this.pruneRemovedProjects(new Set(contexts.map((context) => context.name)));
    const order = roundRobin(contexts, previous.cursor);
    let lastDispatchedOriginalIndex: number | null = null;
    let inPassDispatchReservations = 0;

    for (const context of order) {
      const runtime = runtimeByProject.get(context.name) ?? (await new RuntimeStateStore(context.repoRoot).read());
      const previousSummary = previous.projects.find((project) => project.name === context.name);
      const activeRuns = runtime.activeRuns.length;
      let globalAvailable = this.globalAvailable(globalConcurrency, runtimeByProject, inPassDispatchReservations);
      const projectAvailable = Math.max(0, context.maxConcurrency - activeRuns);
      const dispatchLimit = Math.max(0, Math.min(globalAvailable, projectAvailable));
      const base = this.baseSummary(context, runtime, previousSummary);

      let lockPath: string | null = null;
      try {
        lockPath = await this.lockProject(context, releaseLocksAfterPass);
      } catch (error) {
        summaries.set(context.name, {
          ...base,
          status: "locked",
          lastError: error instanceof Error ? error.message : String(error),
          errorCategory: "project_lock"
        });
        continue;
      }

      try {
        const result = await this.projectOrchestrator(context).runOnce(waitForWorkers, { dispatchLimit });
        const dispatched = result?.dispatched ?? 0;
        const postRuntime = await new RuntimeStateStore(context.repoRoot).read();
        runtimeByProject.set(context.name, postRuntime);
        const representedDispatches = Math.max(0, postRuntime.activeRuns.length - runtime.activeRuns.length);
        inPassDispatchReservations += Math.max(0, dispatched - representedDispatches);
        globalAvailable = this.globalAvailable(globalConcurrency, runtimeByProject, inPassDispatchReservations);
        const postProjectAvailable = Math.max(0, context.maxConcurrency - postRuntime.activeRuns.length);
        if (dispatched > 0) {
          lastDispatchedOriginalIndex = contexts.findIndex((candidate) => candidate.name === context.name);
        }
        summaries.set(context.name, {
          ...this.baseSummary(context, postRuntime, previousSummary),
          status:
            dispatched > 0
              ? "dispatched"
              : postProjectAvailable <= 0
                ? "project_capacity_exhausted"
                : globalAvailable <= 0
                  ? "global_capacity_exhausted"
                  : "idle",
          dispatched,
          candidates: result?.candidates,
          lastSuccessfulTrackerReadAt: new Date().toISOString(),
          lastError: undefined,
          errorCategory: undefined
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const transient = isTransientTrackerError(message);
        summaries.set(context.name, {
          ...base,
          status: transient ? "transient_tracker_error" : "failed",
          lastError: message,
          errorCategory: transient ? "tracker_network" : "orchestrator"
        });
      } finally {
        if (releaseLocksAfterPass && lockPath) await releaseProjectRunnerLock(lockPath);
      }
    }

    const nextCursor = lastDispatchedOriginalIndex == null || contexts.length === 0 ? previous.cursor % Math.max(contexts.length, 1) : (lastDispatchedOriginalIndex + 1) % contexts.length;
    const state: RegistryRuntimeState = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      cursor: nextCursor,
      globalConcurrency,
      projects: registry.projects
        .map((project) => {
          const context = contexts.find((candidate) => candidate.name === project.name);
          if (!context) return summaries.get(project.name);
          return summaries.get(context.name) ?? this.baseSummary(context, runtimeByProject.get(context.name)!, previous.projects.find((item) => item.name === context.name));
        })
        .filter((summary): summary is RegistryProjectSummary => Boolean(summary))
    };
    await this.stateStore.write(state);
    return { state, summaries: state.projects };
  }

  private async resolveContext(project: ProjectConfig): Promise<RegistryProjectContext> {
    const paths = resolveRegistryProjectPaths(project, this.registryPath);
    const workflow = await loadWorkflow(paths.workflowPath);
    const resolvedEnv = await resolveRepoEnv(paths.repoRoot, this.options.env ?? process.env);
    const config = resolveServiceConfig(workflow, resolvedEnv.env);
    const registryLimit = project.maxConcurrency ?? config.agent.maxConcurrentAgents;
    const maxConcurrency = Math.max(1, Math.min(config.agent.maxConcurrentAgents, registryLimit));
    return {
      project,
      name: project.name,
      repoRoot: paths.repoRoot,
      workflowPath: paths.workflowPath,
      maxConcurrency,
      config
    };
  }

  private projectOrchestrator(context: RegistryProjectContext): ProjectOrchestrator {
    const contextKey = projectContextKey(context);
    const existing = this.orchestrators.get(context.name);
    if (existing?.contextKey === contextKey) return existing.orchestrator;
    const created =
      this.options.createProjectOrchestrator?.(context) ??
      new Orchestrator({
        repoRoot: context.repoRoot,
        workflowPath: context.workflowPath,
        env: this.options.env,
        maxConcurrentAgents: context.maxConcurrency
      });
    this.orchestrators.set(context.name, { contextKey, orchestrator: created });
    return created;
  }

  private async lockProject(context: RegistryProjectContext, releaseLocksAfterPass: boolean): Promise<string> {
    const contextKey = projectContextKey(context);
    if (!releaseLocksAfterPass) {
      const existing = this.heldLocks.get(context.name);
      if (existing?.contextKey === contextKey) return existing.lockPath;
      if (existing) {
        await releaseProjectRunnerLock(existing.lockPath);
        this.heldLocks.delete(context.name);
      }
    }
    const lockPath = await acquireProjectRunnerLock(context.repoRoot, `registry:${context.name}`);
    if (!releaseLocksAfterPass) this.heldLocks.set(context.name, { contextKey, lockPath });
    return lockPath;
  }

  private async releaseHeldLocks(): Promise<void> {
    for (const held of this.heldLocks.values()) {
      await releaseProjectRunnerLock(held.lockPath);
    }
    this.heldLocks.clear();
  }

  private async pruneRemovedProjects(activeNames: Set<string>): Promise<void> {
    for (const [name, held] of [...this.heldLocks.entries()]) {
      if (!activeNames.has(name)) {
        await releaseProjectRunnerLock(held.lockPath);
        this.heldLocks.delete(name);
      }
    }
    for (const name of [...this.orchestrators.keys()]) {
      if (!activeNames.has(name)) this.orchestrators.delete(name);
    }
  }

  private globalAvailable(globalConcurrency: number, runtimeByProject: Map<string, RuntimeState>, inPassDispatchReservations: number): number {
    const activeGlobal = [...runtimeByProject.values()].reduce((sum, runtime) => sum + runtime.activeRuns.length, 0);
    return Math.max(0, globalConcurrency - activeGlobal - inPassDispatchReservations);
  }

  private baseSummary(context: RegistryProjectContext, runtime: RuntimeState, previous: RegistryProjectSummary | undefined): RegistryProjectSummary {
    return {
      name: context.name,
      repoRoot: context.repoRoot,
      workflowPath: context.workflowPath,
      status: "idle",
      checkedAt: new Date().toISOString(),
      activeRuns: runtime.activeRuns.length,
      retryQueue: runtime.retryQueue.length,
      claimedIssues: runtime.claimedIssues.length,
      maxConcurrency: context.maxConcurrency,
      configuredMaxConcurrentAgents: context.config.agent.maxConcurrentAgents,
      lastSuccessfulTrackerReadAt: previous?.lastSuccessfulTrackerReadAt,
      trustMode: context.config.trustMode,
      lifecycleMode: context.config.lifecycle.mode,
      automationProfile: context.config.automation.profile,
      automationRepairPolicy: context.config.automation.repairPolicy,
      daemonFreshnessStatus: runtime.daemon?.freshnessStatus,
      daemonFreshnessMessage: runtime.daemon?.freshnessMessage
    };
  }
}

function roundRobin<T>(items: T[], cursor: number): T[] {
  if (items.length === 0) return [];
  const start = cursor % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function isTransientTrackerError(message: string): boolean {
  return /fetch failed|network|econnreset|etimedout|eai_again|enotfound|socket hang up|temporary|rate limit/i.test(message);
}

function projectContextKey(context: RegistryProjectContext): string {
  return JSON.stringify({
    repoRoot: context.repoRoot,
    workflowPath: context.workflowPath,
    maxConcurrency: context.maxConcurrency
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
