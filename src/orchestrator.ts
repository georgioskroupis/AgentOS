import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { evaluateMergeReadiness, GitHubClient } from "./github.js";
import { issueStateFromHandoff, IssueStateStore } from "./issue-state.js";
import { JsonlLogger } from "./logging.js";
import { LinearClient } from "./linear.js";
import { CodexAppServerRunner } from "./runner/app-server.js";
import { loadWorkflow, renderPrompt, resolveServiceConfig, validateDispatchConfig } from "./workflow.js";
import { WorkspaceManager } from "./workspace.js";
import type { AgentRunner, Issue, IssueTracker, ServiceConfig, WorkflowDefinition, Workspace } from "./types.js";

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
  issue: Issue;
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
  private completedMarkers = new Map<string, string>();
  private mergeWaitingMarkers = new Map<string, string>();

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
    await this.dispatchDueRetries();
    await this.shepherdMergingIssues();
    const candidates = await this.tracker.fetchCandidates(this.config.tracker.activeStates);
    for (const issue of candidates) {
      if (!this.isEligible(issue)) continue;
      if (this.running.size >= this.config.agent.maxConcurrentAgents) break;
      if (!this.hasSlot(issue.state)) continue;
      const retry = this.retries.get(issue.id);
      this.dispatch(issue, retry && retry.dueAtMs <= Date.now() ? retry.attempt : null);
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
    this.retries.delete(issue.id);
    this.completedMarkers.delete(issue.id);
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
      await this.markLinearStarted(issue, workspace, attempt);
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
        await this.handleFailedRun(issue, workspace, attempt, result.error ?? result.status);
      } else {
        this.completedMarkers.set(issue.id, completionMarker(issue));
        await this.markLinearSucceeded(issue, workspace);
      }
    } catch (error) {
      await this.handleFailedRun(issue, workspace, attempt, error instanceof Error ? error.message : String(error));
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

  private async dispatchDueRetries(): Promise<void> {
    const due = [...this.retries.values()]
      .filter((retry) => retry.dueAtMs <= Date.now())
      .sort((a, b) => a.dueAtMs - b.dueAtMs);
    if (due.length === 0) return;

    const states = await this.tracker.fetchIssueStates(due.map((retry) => retry.issueId)).catch(() => null);
    for (const retry of due) {
      if (this.running.size >= this.config.agent.maxConcurrentAgents) break;
      if (this.running.has(retry.issueId) || this.claimed.has(retry.issueId)) continue;
      const current = states?.get(retry.issueId);
      if (current === null) {
        this.retries.delete(retry.issueId);
        continue;
      }
      const issue = current ?? retry.issue;
      if (isStateIn(issue.state, this.config.tracker.terminalStates)) {
        this.retries.delete(retry.issueId);
        continue;
      }
      if (!this.hasSlot(issue.state)) continue;
      this.dispatch(issue, retry.attempt);
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
      } else if (!isStateIn(issue.state, runningAllowedStates(this.config))) {
        running.abortController.abort();
      }
    }
    for (const id of stale) {
      await this.logger.write({ type: "run_stalled", issueId: id, message: "stall timeout exceeded" });
    }
  }

  private async shepherdMergingIssues(): Promise<void> {
    const mergeState = this.config.tracker.mergeState;
    if (!mergeState) return;
    const issues = await this.tracker.fetchCandidates([mergeState]);
    for (const issue of issues) {
      await this.shepherdMergeIssue(issue);
    }
  }

  private async shepherdMergeIssue(issue: Issue): Promise<void> {
    const stateStore = new IssueStateStore(resolve(this.options.repoRoot));
    const state = await stateStore.read(issue.identifier);
    if (!state?.prUrl) {
      await this.markMergeFailed(issue, "No pull request metadata was found for this issue.");
      return;
    }

    await this.logger.write({
      type: "merge_shepherd_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: state.prUrl
    });

    const github = new GitHubClient(this.config.github.command);
    try {
      const pr = await github.getPullRequest(state.prUrl, resolve(this.options.repoRoot));
      if (pr.merged) {
        await this.commentIssue(issue, `### AgentOS merge shepherd\n\nPull request is already merged: ${state.prUrl}`);
        await this.moveIssue(issue, this.config.github.doneState);
        return;
      }

      const readiness = evaluateMergeReadiness(pr, this.config.github.requireChecks);
      if (!readiness.ready) {
        if (readiness.reason.includes("pending")) {
          await this.markMergeWaiting(issue, state.prUrl, readiness.reason);
        } else {
          await this.markMergeFailed(issue, readiness.reason, state.prUrl);
        }
        return;
      }

      await this.commentIssue(issue, `### AgentOS merge shepherd\n\nChecks are green and the pull request is mergeable. Starting ${this.config.github.mergeMethod} merge.\n\n- PR: ${state.prUrl}`);
      await github.mergePullRequest(state.prUrl, this.config.github, resolve(this.options.repoRoot));
      await this.commentIssue(issue, `### AgentOS merge complete\n\nMerged successfully.\n\n- PR: ${state.prUrl}\n- Method: ${this.config.github.mergeMethod}`);
      await this.moveIssue(issue, this.config.github.doneState);
      await this.logger.write({
        type: "merge_succeeded",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: state.prUrl
      });
    } catch (error) {
      await this.markMergeFailed(issue, error instanceof Error ? error.message : String(error), state.prUrl);
    }
  }

  private isEligible(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    if (this.retries.has(issue.id) && this.retries.get(issue.id)!.dueAtMs > Date.now()) return false;
    if (this.completedMarkers.get(issue.id) === completionMarker(issue)) return false;
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

  private async handleFailedRun(issue: Issue, workspace: Workspace, previousAttempt: number | null, error: string): Promise<void> {
    const nextAttempt = previousAttempt == null ? 1 : previousAttempt + 1;
    if (nextAttempt > this.config.agent.maxRetryAttempts) {
      await this.markLinearFailed(issue, workspace, previousAttempt, error);
      return;
    }
    const retry = this.scheduleRetry(issue, previousAttempt, error);
    await this.markLinearRetryScheduled(issue, workspace, retry);
  }

  private scheduleRetry(issue: Issue, previousAttempt: number | null, error: string | null, overrideDelayMs?: number): RetryEntry {
    const attempt = previousAttempt == null ? 1 : previousAttempt + 1;
    const delay = overrideDelayMs ?? Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.config.agent.maxRetryBackoffMs);
    const retry = {
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt,
      dueAtMs: Date.now() + delay,
      error
    };
    this.retries.set(issue.id, retry);
    return retry;
  }

  private async markLinearStarted(issue: Issue, workspace: Workspace, attempt: number | null): Promise<void> {
    await this.moveIssue(issue, this.config.tracker.runningState);
    await this.commentIssue(
      issue,
      [
        "### AgentOS started",
        "",
        "The Symphony loop picked up this issue and started a Codex run.",
        "",
        `- Attempt: ${displayAttempt(attempt)}`,
        `- Workspace: \`${workspace.path}\``,
        `- Branch: \`agent/${workspace.workspaceKey}\``,
        "- Logs: `.agent-os/runs/agent-os.jsonl`"
      ].join("\n")
    );
  }

  private async markLinearSucceeded(issue: Issue, workspace: Workspace): Promise<void> {
    const handoff = await readHandoff(workspace.path, issue.identifier);
    if (handoff) {
      const state = issueStateFromHandoff(issue, handoff);
      if (state) {
        await new IssueStateStore(resolve(this.options.repoRoot)).write(state);
        await this.logger.write({
          type: "pr_metadata_persisted",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: state.prUrl,
          payload: state
        });
      }
    }
    await this.commentIssue(
      issue,
      handoff ??
        [
          "### AgentOS handoff",
          "",
          "Codex completed this run successfully, but no handoff file was found.",
          "",
          `- Workspace: \`${workspace.path}\``,
          "- Expected validation: project harness check"
        ].join("\n")
    );
    await this.moveIssue(issue, this.config.tracker.reviewState);
  }

  private async markLinearRetryScheduled(issue: Issue, workspace: Workspace, retry: RetryEntry): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS retry scheduled",
        "",
        "Codex did not complete the run successfully. The Symphony loop will retry automatically.",
        "",
        `- Next retry: ${retry.attempt} of ${this.config.agent.maxRetryAttempts}`,
        `- Retry after: ${new Date(retry.dueAtMs).toISOString()}`,
        `- Workspace: \`${workspace.path}\``,
        `- Error: ${retry.error ?? "unknown"}`
      ].join("\n")
    );
  }

  private async markLinearFailed(issue: Issue, workspace: Workspace, attempt: number | null, error: string): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS needs human input",
        "",
        "Codex could not complete this issue within the configured retry budget.",
        "",
        `- Last attempt: ${displayAttempt(attempt)}`,
        `- Workspace: \`${workspace.path}\``,
        `- Error: ${error}`,
        "",
        "Please adjust the issue, repo, or workflow instructions before returning it to an active state."
      ].join("\n")
    );
    await this.moveIssue(issue, this.config.tracker.needsInputState);
  }

  private async markMergeWaiting(issue: Issue, prUrl: string, reason: string): Promise<void> {
    const marker = `${issue.updated_at ?? ""}:${reason}`;
    if (this.mergeWaitingMarkers.get(issue.id) === marker) return;
    this.mergeWaitingMarkers.set(issue.id, marker);
    await this.commentIssue(
      issue,
      [
        "### AgentOS merge waiting",
        "",
        "The issue is in `Merging`, but the pull request is not ready yet.",
        "",
        `- PR: ${prUrl}`,
        `- Reason: ${reason}`
      ].join("\n")
    );
    await this.logger.write({
      type: "merge_waiting",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl }
    });
  }

  private async markMergeFailed(issue: Issue, reason: string, prUrl?: string): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS merge needs human review",
        "",
        "The merge shepherd could not safely merge this issue.",
        "",
        prUrl ? `- PR: ${prUrl}` : null,
        `- Reason: ${reason}`,
        "",
        "Please resolve the issue and move it back to `Merging` when ready."
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    );
    await this.moveIssue(issue, this.config.tracker.reviewState);
    await this.logger.write({
      type: "merge_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl }
    });
  }

  private async moveIssue(issue: Issue, stateName: string | null): Promise<void> {
    if (!stateName || !this.tracker.move) return;
    await this.tracker.move(issue.identifier, stateName).catch((error: Error) =>
      this.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `move to ${stateName}: ${error.message}`
      })
    );
  }

  private async commentIssue(issue: Issue, body: string): Promise<void> {
    if (!this.tracker.comment) return;
    await this.tracker.comment(issue.identifier, body).catch((error: Error) =>
      this.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `comment: ${error.message}`
      })
    );
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

function completionMarker(issue: Issue): string {
  return issue.updated_at ?? `${issue.state}:${issue.title}`;
}

function displayAttempt(attempt: number | null): number {
  return (attempt ?? 0) + 1;
}

function isStateIn(state: string, states: string[]): boolean {
  const normalized = state.toLowerCase();
  return states.map((item) => item.toLowerCase()).includes(normalized);
}

function runningAllowedStates(config: ServiceConfig): string[] {
  return [...config.tracker.activeStates, config.tracker.runningState].filter((state): state is string => Boolean(state));
}

async function readHandoff(workspacePath: string, identifier: string): Promise<string | null> {
  const path = join(workspacePath, ".agent-os", `handoff-${identifier}.md`);
  if (!(await exists(path))) return null;
  const text = await readText(path);
  return text.trim() ? text : null;
}
