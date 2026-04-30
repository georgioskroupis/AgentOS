import { resolve } from "node:path";
import { JsonlLogger } from "./logging.js";
import { LinearClient } from "./linear.js";
import { CodexAppServerRunner } from "./runner/app-server.js";
import { loadWorkflow, renderPrompt, resolveServiceConfig, validateDispatchConfig } from "./workflow.js";
import { WorkspaceManager } from "./workspace.js";
import type { AgentRunner, Issue, IssueTracker, ServiceConfig, WorkflowDefinition } from "./types.js";

export interface OrchestratorOptions {
  repoRoot: string;
  workflowPath: string;
  tracker?: IssueTracker;
  runner?: AgentRunner;
  logger?: JsonlLogger;
  env?: NodeJS.ProcessEnv;
}

interface RunningEntry {
  issue: Issue;
  startedAt: number;
  abortController: AbortController;
  promise: Promise<void>;
}

interface RetryEntry {
  issueId: string;
  identifier: string;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export class Orchestrator {
  private workflow!: WorkflowDefinition;
  private config!: ServiceConfig;
  private tracker!: IssueTracker;
  private runner!: AgentRunner;
  private logger: JsonlLogger;
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retries = new Map<string, RetryEntry>();

  constructor(private readonly options: OrchestratorOptions) {
    this.logger = options.logger ?? new JsonlLogger(resolve(options.repoRoot));
  }

  async reload(): Promise<void> {
    this.workflow = await loadWorkflow(this.options.workflowPath);
    this.config = resolveServiceConfig(this.workflow, this.options.env);
    this.tracker = this.options.tracker ?? new LinearClient(this.config.tracker);
    this.runner = this.options.runner ?? new CodexAppServerRunner();
  }

  async runOnce(waitForWorkers = true): Promise<void> {
    await this.reload();
    await this.reconcile();
    validateDispatchConfig(this.config);
    const candidates = await this.tracker.fetchCandidates(this.config.tracker.activeStates);
    for (const issue of candidates) {
      if (!this.isEligible(issue)) continue;
      if (!this.hasSlot(issue.state)) break;
      this.dispatch(issue, null);
    }
    if (waitForWorkers) {
      await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
    }
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    await this.reload();
    while (!signal.aborted) {
      try {
        await this.runOnce(false);
      } catch (error) {
        await this.logger.write({
          type: "orchestrator_error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      await sleep(this.config.polling.intervalMs, signal);
    }
  }

  private dispatch(issue: Issue, attempt: number | null): void {
    this.claimed.add(issue.id);
    const abortController = new AbortController();
    const promise = this.runIssue(issue, attempt, abortController).finally(() => {
      this.running.delete(issue.id);
      this.claimed.delete(issue.id);
    });
    this.running.set(issue.id, {
      issue,
      startedAt: Date.now(),
      abortController,
      promise
    });
  }

  private async runIssue(issue: Issue, attempt: number | null, abortController: AbortController): Promise<void> {
    await this.logger.write({
      type: "run_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: issue.title
    });
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    const workspace = await workspaceManager.createOrReuse(issue.identifier);
    try {
      await workspaceManager.beforeRun(workspace);
      const prompt = await renderPrompt(this.workflow.prompt_template, issue, attempt);
      const result = await this.runner.run({
        issue,
        prompt,
        attempt,
        workspace,
        config: this.config,
        signal: abortController.signal,
        onEvent: (event) => void this.logger.write(event)
      });
      await this.logger.write({
        type: `run_${result.status}`,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: result.error ?? "completed",
        payload: result
      });
      if (result.status !== "succeeded") {
        this.scheduleRetry(issue, attempt, result.error ?? result.status);
      } else {
        this.scheduleRetry(issue, 0, null, 1000);
      }
    } catch (error) {
      this.scheduleRetry(issue, attempt, error instanceof Error ? error.message : String(error));
      await this.logger.write({
        type: "run_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await workspaceManager.afterRun(workspace);
    }
  }

  private async reconcile(): Promise<void> {
    const stale: string[] = [];
    for (const [id, entry] of this.running.entries()) {
      const elapsed = Date.now() - entry.startedAt;
      if (this.config.codex.stallTimeoutMs > 0 && elapsed > this.config.codex.stallTimeoutMs) {
        entry.abortController.abort();
        stale.push(id);
      }
    }
    if (this.running.size === 0) return;
    const states = await this.tracker.fetchIssueStates([...this.running.keys()]).catch(() => null);
    if (!states) return;
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    for (const [id, issue] of states.entries()) {
      const running = this.running.get(id);
      if (!running || !issue) continue;
      const normalized = issue.state.toLowerCase();
      if (this.config.tracker.terminalStates.map((state) => state.toLowerCase()).includes(normalized)) {
        running.abortController.abort();
        await workspaceManager.remove(issue.identifier);
      } else if (!this.config.tracker.activeStates.map((state) => state.toLowerCase()).includes(normalized)) {
        running.abortController.abort();
      }
    }
    for (const id of stale) {
      await this.logger.write({ type: "run_stalled", issueId: id, message: "stall timeout exceeded" });
    }
  }

  private isEligible(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    if (this.retries.has(issue.id) && this.retries.get(issue.id)!.dueAtMs > Date.now()) return false;
    const state = issue.state.toLowerCase();
    if (!this.config.tracker.activeStates.map((item) => item.toLowerCase()).includes(state)) return false;
    if (this.config.tracker.terminalStates.map((item) => item.toLowerCase()).includes(state)) return false;
    if (state === "todo") {
      return issue.blocked_by.every((blocker) => {
        const blockerState = (blocker.state ?? "").toLowerCase();
        return this.config.tracker.terminalStates.map((item) => item.toLowerCase()).includes(blockerState);
      });
    }
    return true;
  }

  private hasSlot(state: string): boolean {
    if (this.running.size >= this.config.agent.maxConcurrentAgents) return false;
    const stateLimit = this.config.agent.maxConcurrentAgentsByState.get(state.toLowerCase());
    if (!stateLimit) return true;
    const runningInState = [...this.running.values()].filter((entry) => entry.issue.state.toLowerCase() === state.toLowerCase()).length;
    return runningInState < stateLimit;
  }

  private scheduleRetry(issue: Issue, previousAttempt: number | null, error: string | null, overrideDelayMs?: number): void {
    const attempt = previousAttempt == null ? 1 : previousAttempt + 1;
    const delay = overrideDelayMs ?? Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.config.agent.maxRetryBackoffMs);
    this.retries.set(issue.id, {
      issueId: issue.id,
      identifier: issue.identifier,
      attempt,
      dueAtMs: Date.now() + delay,
      error
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolvePromise();
      },
      { once: true }
    );
  });
}
