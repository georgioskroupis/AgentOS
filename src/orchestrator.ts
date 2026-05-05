import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { evaluateMergeReadiness, GitHubClient, summarizeCheckDiagnostics, summarizeFeedback, summarizePullRequestForPrompt } from "./github.js";
import { assertPullRequestUrlMatchesRepo, assertPullRequestUrlsMatchRepo } from "./github-repository.js";
import {
  extractPullRequestUrls,
  issueStateFromHandoff,
  IssueStateStore,
  mergeEligiblePullRequests,
  mergeTargetAmbiguityReason,
  mergeTargetPullRequest,
  primaryPullRequestUrl,
  pullRequestUrls,
  reviewTargetPullRequests
} from "./issue-state.js";
import { hybridHandoffComment, orchestratorMayComment, orchestratorMayMoveIssue, usesFullOrchestratorHandoff } from "./lifecycle.js";
import { JsonlLogger } from "./logging.js";
import { LinearClient } from "./linear.js";
import { redactText } from "./redaction.js";
import {
  blockingFindings,
  ensureReviewIterationDir,
  fixPrompt,
  formatFindings,
  readReviewArtifact,
  repeatedBlockingHashes,
  reviewArtifactPath,
  reviewArtifactRelativePath,
  reviewerPrompt,
  writeReviewArtifact
} from "./review.js";
import { CodexAppServerRunner } from "./runner/app-server.js";
import { RunArtifactStore, type RunSummary } from "./runs.js";
import { RuntimeStateStore, type RuntimeActiveRun, type RuntimeRecoverySummary, type RuntimeRetryEntry } from "./runtime-state.js";
import { trustCapabilities } from "./trust.js";
import { validationEvidenceFinding, verifyValidationEvidence } from "./validation.js";
import { loadWorkflow, renderPrompt, resolveServiceConfig, validateDispatchConfig } from "./workflow.js";
import { recoverWorkspaceLocks, WorkspaceManager } from "./workspace.js";
import type { AgentEvent, AgentRunResult, AgentRunner, Issue, IssueState, IssueTracker, PullRequestRef, ReviewFinding, ReviewStateReviewer, ReviewStatus, ReviewTargetMode, RunErrorCategory, ServiceConfig, WorkflowDefinition, Workspace } from "./types.js";
import type { ReviewerArtifact } from "./review.js";

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
  runId: string | null;
  lastCodexEventAt: number | null;
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
  private runArtifacts: RunArtifactStore;
  private runtimeState: RuntimeStateStore;
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retries = new Map<string, RetryEntry>();
  private completedMarkers = new Map<string, string>();
  private mergeWaitingMarkers = new Map<string, string>();
  private startupCleanupDone = false;
  private startupReconstructionDone = false;
  private daemonStartedAt = new Date().toISOString();
  private daemonStartGitSha: string | null = null;
  private daemonStartMainGitSha: string | null = null;
  private freshnessWarningMarker: string | null = null;

  constructor(private readonly options: OrchestratorOptions) {
    this.logger = options.logger ?? new JsonlLogger(resolve(options.repoRoot));
    this.runArtifacts = new RunArtifactStore(resolve(options.repoRoot));
    this.runtimeState = new RuntimeStateStore(resolve(options.repoRoot));
  }

  async reload(): Promise<void> {
    this.workflow = await loadWorkflow(this.options.workflowPath);
    this.config = resolveServiceConfig(this.workflow, this.options.env);
    this.tracker = this.options.tracker ?? new LinearClient(this.config.tracker);
    this.runner = this.options.runner ?? new CodexAppServerRunner();
  }

  async runOnce(waitForWorkers = true): Promise<void> {
    await this.reload();
    await this.refreshDaemonRuntimeState();
    await this.reconstructStartupState();
    await this.cleanupTerminalWorkspaces();
    await this.reconcile();
    validateDispatchConfig(this.config);
    await this.dispatchDueRetries();
    if (this.config.github.mergeMode !== "manual") {
      await this.shepherdMergingIssues();
    }
    const candidates = await this.tracker.fetchCandidates(this.config.tracker.activeStates);
    for (const issue of candidates) {
      if (!this.isEligible(issue)) continue;
      if (this.running.size >= this.config.agent.maxConcurrentAgents) break;
      if (!this.hasSlot(issue.state)) continue;
      const retry = this.retries.get(issue.id);
      const prepared = await this.prepareForDispatch(issue);
      if (!prepared) continue;
      await this.dispatch(prepared, retry && retry.dueAtMs <= Date.now() ? retry.attempt : null);
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

  private async writeRunEvent(runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }): Promise<void> {
    const payload = await this.logger.write({ ...entry, runId });
    await this.runArtifacts.writeEvent(runId, payload);
  }

  private async refreshDaemonRuntimeState(): Promise<void> {
    const repoRoot = resolve(this.options.repoRoot);
    this.daemonStartGitSha ??= await gitRevParse(repoRoot, "HEAD");
    this.daemonStartMainGitSha ??= await gitRevParse(repoRoot, "main").then((sha) => sha ?? gitRevParse(repoRoot, "origin/main"));
    const currentGitSha = await gitRevParse(repoRoot, "HEAD");
    const currentMainGitSha = await gitRevParse(repoRoot, "main").then((sha) => sha ?? gitRevParse(repoRoot, "origin/main"));
    const mainAdvanced = Boolean(this.daemonStartMainGitSha && currentMainGitSha && this.daemonStartMainGitSha !== currentMainGitSha);
    const freshnessMessage = mainAdvanced
      ? `main advanced from ${this.daemonStartMainGitSha} to ${currentMainGitSha}; restart the long-running AgentOS daemon after self-modifying code lands`
      : null;
    await this.runtimeState.setDaemon({
      startedAt: this.daemonStartedAt,
      startGitSha: this.daemonStartGitSha,
      startMainGitSha: this.daemonStartMainGitSha,
      currentGitSha,
      currentMainGitSha,
      workflowPath: this.workflow.workflowPath,
      freshnessStatus: mainAdvanced ? "main_advanced" : "fresh",
      freshnessMessage
    });
    if (freshnessMessage && this.freshnessWarningMarker !== freshnessMessage) {
      this.freshnessWarningMarker = freshnessMessage;
      await this.logger.write({
        type: "daemon_freshness_warning",
        message: freshnessMessage,
        payload: {
          daemonStartedAt: this.daemonStartedAt,
          workflowPath: this.workflow.workflowPath,
          startGitSha: this.daemonStartGitSha,
          startMainGitSha: this.daemonStartMainGitSha,
          currentGitSha,
          currentMainGitSha
        }
      });
    }
  }

  private async reconstructStartupState(): Promise<void> {
    if (this.startupReconstructionDone) return;
    this.startupReconstructionDone = true;

    const runtime = await this.runtimeState.read();
    const issueStore = new IssueStateStore(resolve(this.options.repoRoot));
    const issueStates = await issueStore.list();
    const runningSummaries = (await this.runArtifacts.listRuns()).filter((summary) => summary.status === "running");
    const knownIssueIds = uniqueStrings([
      ...runtime.retryQueue.map((entry) => entry.issueId),
      ...runtime.activeRuns.map((entry) => entry.issueId),
      ...runtime.claimedIssues.map((entry) => entry.issueId),
      ...issueStates.map((state) => state.issueId).filter(Boolean),
      ...runningSummaries.map((summary) => summary.issueId)
    ]);
    const states = knownIssueIds.length > 0 ? await this.tracker.fetchIssueStates(knownIssueIds).catch(() => null) : null;
    const messages: string[] = [];
    let staleRuns = 0;
    let retriesRebuilt = 0;
    let terminalIssues = 0;
    let locksReleased = 0;
    let freshnessWarnings = runtime.daemon?.freshnessStatus === "main_advanced" ? 1 : 0;

    const lockRecoveries = await recoverWorkspaceLocks(this.config.workspace.root).catch(async (error: Error) => {
      await this.logger.write({ type: "startup_recovery_warning", message: `workspace lock recovery failed: ${error.message}` });
      return [];
    });
    locksReleased = lockRecoveries.filter((entry) => entry.recovered).length;
    for (const recovery of lockRecoveries.filter((entry) => entry.recovered)) {
      messages.push(`released stale workspace lock ${recovery.workspaceKey}: ${recovery.reason}`);
    }

    for (const state of issueStates) {
      const current = state.issueId ? states?.get(state.issueId) : undefined;
      if (current && isStateIn(current.state, this.config.tracker.terminalStates)) {
        await this.classifyTerminalIssue(current, `startup recovery: Linear state is ${current.state}`);
        terminalIssues += 1;
        messages.push(`reconciled ${current.identifier} to terminal Linear state ${current.state}`);
        continue;
      }
      const issue = current ?? issueFromState(state);
      if (issue && (await this.classifyAlreadyMergedIssue(issue, state, "startup recovery: recorded pull request is already merged"))) {
        terminalIssues += 1;
        messages.push(`reconciled ${issue.identifier} to already-merged PR truth`);
      }
    }

    const activeByRunId = new Map(runtime.activeRuns.filter((entry) => entry.runId).map((entry) => [entry.runId!, entry]));
    const activeEntries: RuntimeActiveRun[] = [...runtime.activeRuns];
    for (const summary of runningSummaries) {
      if (activeByRunId.has(summary.runId)) continue;
      const issue = issueFromRunSummary(summary);
      activeEntries.push({
        issueId: summary.issueId,
        identifier: summary.issueIdentifier,
        issue,
        attempt: summary.attempt,
        runId: summary.runId,
        startedAt: summary.startedAt,
        lastEventAt: summary.lastEventAt,
        workspacePath: summary.workspacePath
      });
    }
    for (const active of activeEntries) {
      const current = states?.get(active.issueId);
      const issue = current ?? active.issue;
      const result = await this.classifyStaleActiveRun(active, runningSummaries.find((summary) => summary.runId === active.runId), issue);
      if (result.stale) staleRuns += 1;
      if (result.terminal) terminalIssues += 1;
      if (result.retryRebuilt) retriesRebuilt += 1;
      messages.push(...result.messages);
    }

    const runtimeAfterStale = await this.runtimeState.read();
    for (const retry of runtimeAfterStale.retryQueue) {
      const current = states?.get(retry.issueId);
      if (current === null) {
        await this.runtimeState.clearIssue(retry.issueId);
        this.retries.delete(retry.issueId);
        messages.push(`cleared retry for ${retry.identifier}: issue no longer exists in tracker`);
        continue;
      }
      const issue = current ?? retry.issue;
      if (isStateIn(issue.state, this.config.tracker.terminalStates)) {
        await this.classifyTerminalIssue(issue, `startup recovery: retry cleared because Linear state is ${issue.state}`);
        terminalIssues += 1;
        messages.push(`cleared retry for terminal issue ${issue.identifier}`);
        continue;
      }
      const state = issueStates.find((item) => item.issueId === retry.issueId || item.issueIdentifier === retry.identifier) ?? null;
      if (await this.classifyAlreadyMergedIssue(issue, state, "startup recovery: retry cleared because PR is already merged")) {
        terminalIssues += 1;
        messages.push(`cleared retry for already-merged issue ${issue.identifier}`);
        continue;
      }
      this.retries.set(retry.issueId, runtimeRetryToMemory(retry));
      retriesRebuilt += 1;
      messages.push(`rebuilt retry for ${retry.identifier} due ${retry.dueAt}`);
    }

    const runtimeAfterRetries = await this.runtimeState.read();
    for (const claim of runtimeAfterRetries.claimedIssues) {
      if (runtimeAfterRetries.activeRuns.some((entry) => entry.issueId === claim.issueId)) continue;
      await this.runtimeState.removeClaim(claim.issueId);
      messages.push(`released stale claimed issue ${claim.identifier}`);
    }

    const summary: RuntimeRecoverySummary = {
      recoveredAt: new Date().toISOString(),
      messages,
      staleRuns,
      retriesRebuilt,
      terminalIssues,
      locksReleased,
      freshnessWarnings
    };
    await this.runtimeState.recordRecovery(summary);
    await this.logger.write({
      type: "startup_recovery",
      message: messages.length ? messages.join("; ") : "startup recovery completed with no stale runtime state",
      payload: summary
    });
  }

  private async classifyStaleActiveRun(active: RuntimeActiveRun, summary: RunSummary | undefined, issue: Issue): Promise<{ stale: boolean; terminal: boolean; retryRebuilt: boolean; messages: string[] }> {
    const messages: string[] = [];
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(active.identifier);
    const runId = active.runId ?? summary?.runId ?? state?.lastRunId;
    const reason = `startup_recovery: run ${runId ?? "unknown"} was left running by a previous daemon process`;
    const workspacePath = active.workspacePath ?? summary?.workspacePath ?? state?.workspacePath;
    const workspaceMissing = Boolean(workspacePath && !(await exists(workspacePath)));
    if (isStateIn(issue.state, this.config.tracker.terminalStates)) {
      if (runId) await this.runArtifacts.markRunCanceled(runId, `${reason}; Linear state is ${issue.state}`).catch(() => undefined);
      await this.classifyTerminalIssue(issue, `${reason}; Linear state is ${issue.state}`);
      messages.push(`classified stale running run for ${issue.identifier} as terminal (${issue.state})`);
      return { stale: true, terminal: true, retryRebuilt: false, messages };
    }
    if (await this.classifyAlreadyMergedIssue(issue, state, `${reason}; PR already merged`)) {
      if (runId) await this.runArtifacts.markRunCanceled(runId, `${reason}; PR already merged`).catch(() => undefined);
      messages.push(`classified stale running run for ${issue.identifier} as already merged`);
      return { stale: true, terminal: true, retryRebuilt: false, messages };
    }
    if (runId) await this.runArtifacts.markRunStale(runId, workspaceMissing ? `${reason}; workspace is missing` : reason).catch(() => undefined);
    await this.runtimeState.removeActiveRun(issue.id);

    if (workspaceMissing) {
      await this.recordIssueState(issue, {
        phase: "needs-input",
        lastError: `${reason}; workspace is missing`,
        errorCategory: "workspace",
        lifecycleStatus: "implementation_failure",
        stopReason: `${reason}; workspace is missing`,
        workspaceMissingAt: new Date().toISOString()
      });
      messages.push(`marked stale run for ${issue.identifier}: workspace is missing`);
    }

    if (state?.phase === "review" || state?.phase === "fix" || (pullRequestUrls(state).length > 0 && state?.reviewStatus !== "approved")) {
      await this.recordIssueState(issue, {
        phase: "human-required",
        reviewStatus: "human_required",
        lifecycleStatus: "review_escalation",
        lastError: reason,
        errorCategory: state?.phase === "fix" ? "fix" : "review",
        stopReason: reason,
        nextRetryAt: undefined,
        retryAttempt: undefined
      });
      await this.moveIssue(issue, this.config.tracker.reviewState);
      await this.runtimeState.clearIssue(issue.id);
      messages.push(`escalated stale review/fix run for ${issue.identifier} to human review`);
      return { stale: true, terminal: false, retryRebuilt: false, messages };
    }

    const previousAttempt = active.attempt ?? summary?.attempt ?? null;
    const nextAttempt = previousAttempt == null ? 1 : previousAttempt + 1;
    if (nextAttempt > this.config.agent.maxRetryAttempts) {
      await this.recordIssueState(issue, {
        phase: "needs-input",
        lastError: reason,
        errorCategory: "canceled",
        lifecycleStatus: "implementation_failure",
        stopReason: reason,
        nextRetryAt: undefined,
        retryAttempt: undefined
      });
      await this.moveIssue(issue, this.config.tracker.needsInputState);
      await this.runtimeState.clearIssue(issue.id);
      messages.push(`stale run for ${issue.identifier} exhausted retry budget`);
      return { stale: true, terminal: false, retryRebuilt: false, messages };
    }

    const workspace = workspaceFromRuntime(active, summary, this.config.workspace.root);
    const retry = await this.scheduleRetry(issue, previousAttempt, reason, 0, runId, workspace);
    await this.recordIssueState(issue, {
      lastError: reason,
      errorCategory: "canceled",
      lifecycleStatus: "implementation_failure",
      stopReason: reason,
      retryAttempt: retry.attempt,
      nextRetryAt: new Date(retry.dueAtMs).toISOString()
    });
    await this.markLinearRetryScheduled(issue, workspace, retry);
    messages.push(`scheduled startup retry for stale run ${issue.identifier}`);
    return { stale: true, terminal: false, retryRebuilt: false, messages };
  }

  private async prepareForDispatch(issue: Issue): Promise<Issue | null> {
    const states = await this.tracker.fetchIssueStates([issue.id]).catch(() => null);
    const current = states?.get(issue.id);
    if (current === null) {
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: "issue no longer exists in tracker"
      });
      return null;
    }
    const latest = current ?? issue;
    if (isStateIn(latest.state, this.config.tracker.terminalStates)) {
      await this.classifyTerminalIssue(latest, `dispatch skipped because Linear state is ${latest.state}`);
      return null;
    }
    if (!isStateIn(latest.state, this.config.tracker.activeStates)) {
      await this.runtimeState.clearIssue(latest.id);
      this.retries.delete(latest.id);
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: latest.id,
        issueIdentifier: latest.identifier,
        message: `issue state ${latest.state} is not active`
      });
      return null;
    }
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(latest.identifier);
    if (await this.classifyAlreadyMergedIssue(latest, state, "dispatch skipped because recorded PR is already merged")) {
      return null;
    }
    return latest;
  }

  private async preTurnCheck(issue: Issue): Promise<string | null> {
    const states = await this.tracker.fetchIssueStates([issue.id]).catch(() => null);
    const current = states?.get(issue.id);
    if (current === null) return "issue_no_longer_exists";
    const latest = current ?? issue;
    if (isStateIn(latest.state, this.config.tracker.terminalStates)) return `issue_became_terminal:${latest.state}`;
    if (!isStateIn(latest.state, runningAllowedStates(this.config))) return `issue_no_longer_dispatchable:${latest.state}`;
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(latest.identifier);
    if (await this.hasAlreadyMergedPullRequest(state)) return "pull_request_already_merged";
    return null;
  }

  private async classifyTerminalIssue(issue: Issue, reason: string): Promise<void> {
    const phase: IssueState["phase"] = issue.state.toLowerCase() === this.config.github.doneState.toLowerCase() ? "completed" : "canceled";
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    const workspacePath = join(this.config.workspace.root, issue.identifier.replace(/[^A-Za-z0-9._-]/g, "_"));
    const missingWorkspace = !(await exists(workspacePath));
    await workspaceManager.remove(issue.identifier).catch((error: Error) =>
      this.logger.write({
        type: "startup_recovery_warning",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `terminal workspace cleanup failed: ${error.message}`
      })
    );
    await this.recordIssueState(issue, {
      phase,
      lifecycleStatus: missingWorkspace ? "terminal_missing_workspace" : "terminal_linear",
      terminalState: issue.state,
      terminalReason: reason,
      terminalAt: new Date().toISOString(),
      activeRunId: undefined,
      nextRetryAt: undefined,
      retryAttempt: undefined,
      stopReason: reason,
      ...(missingWorkspace ? { workspaceMissingAt: new Date().toISOString() } : {})
    });
    await this.runtimeState.clearIssue(issue.id);
    this.retries.delete(issue.id);
    this.completedMarkers.set(issue.id, completionMarker(issue));
    await this.logger.write({
      type: "issue_terminal_reconciled",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { state: issue.state, phase, missingWorkspace }
    });
  }

  private async classifyAlreadyMergedIssue(issue: Issue, state: IssueState | null, reason: string): Promise<boolean> {
    const prUrl = await this.alreadyMergedPullRequestUrl(state);
    if (!prUrl) return false;
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    await workspaceManager.remove(issue.identifier).catch((error: Error) =>
      this.logger.write({
        type: "startup_recovery_warning",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `already-merged workspace cleanup failed: ${error.message}`
      })
    );
    await this.recordIssueState(issue, {
      phase: "completed",
      lifecycleStatus: "already_merged_pr",
      mergedAt: new Date().toISOString(),
      terminalReason: reason,
      terminalAt: new Date().toISOString(),
      activeRunId: undefined,
      nextRetryAt: undefined,
      retryAttempt: undefined,
      stopReason: reason
    });
    await this.runtimeState.clearIssue(issue.id);
    this.retries.delete(issue.id);
    this.completedMarkers.set(issue.id, completionMarker(issue));
    if (!isStateIn(issue.state, this.config.tracker.terminalStates)) {
      await this.moveIssue(issue, this.config.github.doneState);
    }
    await this.logger.write({
      type: "issue_already_merged_reconciled",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl }
    });
    return true;
  }

  private async hasAlreadyMergedPullRequest(state: IssueState | null): Promise<boolean> {
    return Boolean(await this.alreadyMergedPullRequestUrl(state));
  }

  private async alreadyMergedPullRequestUrl(state: IssueState | null): Promise<string | null> {
    const urls = uniqueStrings([mergeTargetPullRequest(state)?.url, primaryPullRequestUrl(state), ...pullRequestUrls(state)].filter((url): url is string => Boolean(url)));
    if (urls.length === 0) return null;
    const github = new GitHubClient(this.config.github.command);
    const repoRoot = resolve(this.options.repoRoot);
    for (const url of urls) {
      const status = await github.getPullRequest(url, repoRoot).catch(async (error: Error) => {
        await this.logger.write({
          type: "github_status_warning",
          message: `could not read PR merge state for ${url}: ${error.message}`
        });
        return null;
      });
      if (status?.merged) return url;
    }
    return null;
  }

  private async dispatch(issue: Issue, attempt: number | null): Promise<void> {
    this.claimed.add(issue.id);
    this.retries.delete(issue.id);
    this.completedMarkers.delete(issue.id);
    const abortController = new AbortController();
    const claimedAt = new Date().toISOString();
    await this.runtimeState.removeRetry(issue.id);
    await this.runtimeState.upsertClaim({
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      claimedAt
    });
    const promise = this.runIssue(issue, attempt, abortController).finally(async () => {
      this.running.delete(issue.id);
      this.claimed.delete(issue.id);
      await this.runtimeState.removeActiveRun(issue.id);
    });
    this.running.set(issue.id, {
      issue,
      startedAt: Date.now(),
      runId: null,
      lastCodexEventAt: null,
      abortController,
      promise
    });
  }

  private async runIssue(issue: Issue, attempt: number | null, abortController: AbortController): Promise<void> {
    const run = await this.runArtifacts.startRun({ issue, attempt });
    const runId = run.runId;
    const running = this.running.get(issue.id);
    if (running) {
      running.runId = runId;
    }
    await this.runtimeState.upsertActiveRun({
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt,
      runId,
      startedAt: run.startedAt,
      lastEventAt: run.startedAt,
      phase: "workspace"
    });
    await this.writeRunEvent(runId, {
      type: "run_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: issue.title
    });
    const stateStore = new IssueStateStore(resolve(this.options.repoRoot));
    await this.recordIssueState(issue, {
      phase: "workspace",
      lastRunId: runId,
      activeRunId: runId,
      retryAttempt: attempt ?? 0,
      lastCodexEventAt: run.startedAt,
      stopReason: undefined
    });
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    const workspace = await workspaceManager.createOrReuse(issue.identifier);
    await this.runtimeState.patchActiveRun(issue.id, {
      workspacePath: workspace.path,
      workspaceKey: workspace.workspaceKey
    });
    await this.recordIssueState(issue, {
      workspacePath: workspace.path,
      workspaceKey: workspace.workspaceKey
    });
    await this.runArtifacts.setWorkspace(runId, workspace);
    try {
      await this.markLinearStarted(issue, workspace, attempt);
      await workspaceManager.beforeRun(workspace);
      const result = await this.runImplementationTurns(issue, attempt, workspace, abortController.signal, runId);
      if (result.status !== "succeeded") {
        await this.writeRunEvent(runId, {
          type: `run_${result.status}`,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: result.error ?? result.status,
          payload: result
        });
        if (isDispatchTerminalStop(result.error)) {
          await this.handleTerminalStoppedRun(issue, result.error ?? result.status, runId);
          await this.runArtifacts.completeRun(runId, result);
          return;
        }
        await this.handleFailedRun(issue, workspace, attempt, result.error ?? result.status, runId);
      } else {
        this.completedMarkers.set(issue.id, completionMarker(issue));
        const handoff = await readHandoff(workspace.path, issue.identifier);
        if (handoff) await this.runArtifacts.writeHandoff(runId, handoff);
        if (handoff) {
          await assertPullRequestUrlsMatchRepo(resolve(this.options.repoRoot), extractPullRequestUrls(handoff));
        }
        const stateFromHandoff = handoff ? issueStateFromHandoff(issue, handoff) : null;
        const validation = handoff ? await verifyValidationEvidence({ issue, handoff, workspacePath: workspace.path, runId }) : null;
        if (validation && validation.state.status !== "passed") {
          const error = validationFailureMessage(validation.state);
          await this.recordIssueState(issue, {
            phase: "validation",
            validation: validation.state,
            lastError: error,
            errorCategory: "validation"
          });
          await this.writeRunEvent(runId, {
            type: "validation_failed",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: error,
            payload: validation.state
          });
          await this.writeRunEvent(runId, {
            type: "run_failed",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: error,
            payload: { ...result, status: "failed", error }
          });
          await this.handleFailedRun(issue, workspace, attempt, error, runId);
          await this.runArtifacts.completeRun(runId, {
            ...result,
            status: "failed",
            error
          });
          return;
        }
        const persistedState = stateFromHandoff
          ? await stateStore.merge(issue.identifier, {
              ...stateFromHandoff,
              ...(validation ? { validation: validation.state } : {})
            })
          : await stateStore.read(issue.identifier);
        if (stateFromHandoff) {
          const primaryPr = primaryPullRequestUrl(stateFromHandoff);
          await this.logger.write({
            type: primaryPr ? "pr_metadata_persisted" : "issue_state_persisted",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: primaryPr ?? stateFromHandoff.outcome,
            payload: stateFromHandoff
          });
          if (stateFromHandoff.outcome === "already_satisfied") {
            await this.logger.write({
              type: "issue_already_satisfied",
              issueId: issue.id,
              issueIdentifier: issue.identifier,
              message: "agent reported acceptance criteria were already satisfied",
              payload: stateFromHandoff
            });
          }
        }
        const reviewedState = await this.reviewIfNeeded(issue, workspace, persistedState, attempt, abortController.signal);
        await this.markLinearSucceeded(issue, workspace, handoff, reviewedState ?? persistedState ?? undefined);
        await this.writeRunEvent(runId, {
          type: "run_succeeded",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: "completed",
          payload: result
        });
      }
      await this.runArtifacts.completeRun(runId, result);
    } catch (error) {
      await this.handleFailedRun(issue, workspace, attempt, error instanceof Error ? error.message : String(error), runId);
      await this.writeRunEvent(runId, {
        type: "run_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: error instanceof Error ? error.message : String(error)
      });
      await this.runArtifacts.failRun(runId, error instanceof Error ? error.message : String(error));
      await this.recordIssueState(issue, {
        errorCategory: categorizeRunError(error instanceof Error ? error.message : String(error)),
        lastError: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await workspaceManager.afterRun(workspace);
    }
  }

  private async runImplementationTurns(issue: Issue, attempt: number | null, workspace: Workspace, signal: AbortSignal | undefined, runId: string): Promise<AgentRunResult> {
    let result: AgentRunResult = { status: "failed", error: "no_turn_started" };
    for (let turnNumber = 1; turnNumber <= this.config.agent.maxTurns; turnNumber += 1) {
      const preTurnStop = await this.preTurnCheck(issue);
      if (preTurnStop) return { status: "canceled", error: preTurnStop };
      await this.recordIssueState(issue, { phase: "prompt" });
      const prompt = await this.implementationPrompt(issue, attempt, turnNumber, runId);
      await this.runArtifacts.writePrompt(runId, prompt);
      await this.recordIssueState(issue, { phase: "streaming-turn" });
      result = await this.runner.run({
        issue,
        prompt,
        attempt,
        workspace,
        config: this.config,
        signal,
        onEvent: (event) => {
          this.markRunningActivity(issue.id, event.timestamp);
          void this.writeRunEvent(runId, { ...event, runId });
        }
      });
      await this.writeRunEvent(runId, {
        type: "turn_completed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `turn ${turnNumber} ${result.status}`,
        payload: { turnNumber, maxTurns: this.config.agent.maxTurns, result }
      });
      if (result.status !== "succeeded") return result;
      if (await readHandoff(workspace.path, issue.identifier)) return result;

      const current = await this.tracker.fetchIssueStates([issue.id]).then((states) => states.get(issue.id)).catch(() => null);
      if (current && !isStateIn(current.state, runningAllowedStates(this.config))) return result;
      if (turnNumber < this.config.agent.maxTurns) {
        await this.logger.write({
          type: "turn_continued",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: "successful turn ended without a handoff; continuing within max_turns",
          payload: { turnNumber, maxTurns: this.config.agent.maxTurns }
        });
      }
    }
    if (result.status === "succeeded" && !(await readHandoff(workspace.path, issue.identifier))) {
      return { ...result, status: "failed", error: "missing_handoff" };
    }
    return result;
  }

  private async implementationPrompt(issue: Issue, attempt: number | null, turnNumber: number, runId: string): Promise<string> {
    const base = await renderPrompt(this.workflow.prompt_template, issue, attempt);
    const runContext = [
      "",
      "## AgentOS Run Context",
      "",
      `Run ID: ${runId}`,
      `Validation evidence path: .agent-os/validation/${issue.identifier}.json`,
      "Include this run ID and the current `git rev-parse HEAD` value in the validation evidence JSON."
    ].join("\n");
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(issue.identifier);
    const continuation = turnNumber > 1
      ? [
          "",
          "## AgentOS Continuation",
          "",
          `This is turn ${turnNumber} of ${this.config.agent.maxTurns}. The previous turn completed without writing the required handoff file.`,
          "Continue the same issue in this workspace and write the required `.agent-os/handoff-<issue>.md` before finishing."
        ].join("\n")
      : "";
    const existingPr = primaryPullRequestUrl(state);
    if (!existingPr || issue.state.toLowerCase() !== "todo") return `${base}${runContext}${continuation}`;

    const feedback = await this.githubFeedbackSummary(existingPr).catch((error: Error) => `Could not fetch GitHub feedback: ${error.message}`);
    return [
      base,
      runContext,
      continuation,
      "",
      "## Existing PR Feedback Re-entry",
      "",
      "AgentOS found an existing pull request for this issue. Treat this run as a feedback-fix/update pass, not a fresh implementation.",
      "",
      `Existing PR: ${existingPr}`,
      "",
      feedback || "No recent feedback was found.",
      "",
      "Update the existing branch and PR, rerun validation, and refresh the handoff file."
    ].join("\n");
  }

  private async githubFeedbackSummary(prUrl: string): Promise<string> {
    const github = new GitHubClient(this.config.github.command);
    const status = await github.getPullRequest(prUrl, resolve(this.options.repoRoot));
    const threads = await github.getPullRequestReviewThreads(prUrl, resolve(this.options.repoRoot)).catch(() => []);
    return summarizeFeedback(status, threads);
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
        await this.classifyTerminalIssue(issue, "retry skipped because Linear state is terminal");
        this.retries.delete(retry.issueId);
        await this.runtimeState.clearIssue(retry.issueId);
        continue;
      }
      if (!this.hasSlot(issue.state)) continue;
      const prepared = await this.prepareForDispatch(issue);
      if (!prepared) continue;
      await this.dispatch(prepared, retry.attempt);
    }
  }

  private async cleanupTerminalWorkspaces(): Promise<void> {
    if (this.startupCleanupDone) return;
    this.startupCleanupDone = true;
    if (!this.tracker.fetchTerminalIssues) return;
    try {
      const issues = await this.tracker.fetchTerminalIssues(this.config.tracker.terminalStates);
      const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
      for (const issue of issues) {
        await workspaceManager.remove(issue.identifier);
        await this.logger.write({
          type: "workspace_cleaned",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: "terminal issue workspace removed at startup"
        });
      }
    } catch (error) {
      await this.logger.write({
        type: "workspace_cleanup_warning",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async reconcile(): Promise<void> {
    const stale: string[] = [];
    for (const [id, entry] of this.running.entries()) {
      const elapsed = Date.now() - (entry.lastCodexEventAt ?? entry.startedAt);
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

  private async reviewIfNeeded(issue: Issue, workspace: Workspace, state: IssueState | null, attempt: number | null, signal?: AbortSignal): Promise<IssueState | null> {
    if (!this.config.review.enabled) return state;
    const reviewTargetMode = this.config.review.targetMode ?? "merge-eligible";
    if (!state || state.outcome === "already_satisfied") return state;
    const initialReviewTargets = reviewTargetPullRequests(state, reviewTargetMode);
    if (initialReviewTargets.length === 0) {
      return pullRequestUrls(state).length > 0 ? this.recordReviewTargetSelectionFailure(issue, state, reviewTargetMode) : state;
    }
    const initialReviewTargetUrls = initialReviewTargets.map((target) => target.url);
    const initialReviewTargetList = formatPullRequestTargets(initialReviewTargets);

    await this.commentIssue(
      issue,
      [
        "### AgentOS automated review started",
        "",
        "The Ralph Wiggum loop is reviewing the selected PR target(s) before moving the issue to Human Review.",
        "",
        `- Review target mode: ${reviewTargetMode}`,
        initialReviewTargetList,
        `- Required reviewers: ${this.config.review.requiredReviewers.join(", ")}`,
        `- Max iterations: ${this.config.review.maxIterations}`
      ].join("\n")
    );

    const repoRoot = resolve(this.options.repoRoot);
    let previousFindings = state.findings ?? [];
    let latestState = await this.recordIssueState(issue, {
      phase: "review",
      reviewStatus: "pending",
      reviewIteration: state.reviewIteration ?? 0,
      reviewTargetMode,
      reviewTargetUrls: initialReviewTargetUrls
    });
    for (let iteration = (state.reviewIteration ?? 0) + 1; iteration <= this.config.review.maxIterations; iteration += 1) {
      const reviewTargets = reviewTargetPullRequests(latestState, reviewTargetMode);
      if (reviewTargets.length === 0) {
        return pullRequestUrls(latestState).length > 0 ? this.recordReviewTargetSelectionFailure(issue, latestState, reviewTargetMode) : latestState;
      }
      const reviewPr = reviewTargets[0].url;
      const reviewTargetUrls = reviewTargets.map((target) => target.url);
      const reviewTargetList = formatPullRequestTargets(reviewTargets);
      const workspaceReviewDir = await ensureReviewIterationDir(workspace.path, issue.identifier, iteration);
      const githubContext = await this.githubReviewContext(reviewTargets).catch(async (error: Error) => {
        latestState = await this.recordIssueState(issue, {
          phase: "review",
          reviewStatus: "human_required",
          lastError: error.message,
          errorCategory: "review",
          reviewTargetMode,
          reviewTargetUrls
        });
        await this.commentIssue(issue, `### AgentOS automated review needs human judgment\n\nAgentOS could not read the selected pull request target(s) for review.\n\n${reviewTargetList}\n- Error: ${error.message}`);
        await this.logger.write({
          type: "review_human_required",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: error.message,
          payload: { prUrls: reviewTargetUrls }
        });
        return null;
      });
      if (!githubContext) return latestState;
      const nonOpen = githubContext.entries.find((entry) => entry.status.state && entry.status.state.toUpperCase() !== "OPEN");
      if (nonOpen) {
        latestState = await this.recordIssueState(issue, {
          phase: "review",
          reviewStatus: "human_required",
          lastError: `pull request is ${nonOpen.status.state}`,
          errorCategory: "review",
          reviewTargetMode,
          reviewTargetUrls
        });
        await this.commentIssue(issue, `### AgentOS automated review needs human judgment\n\nSelected pull request target is not open.\n\n- PR: ${nonOpen.target.url}\n- State: ${nonOpen.status.state}`);
        return latestState;
      }
      const reviewers = this.reviewersFor([...new Set(githubContext.entries.flatMap((entry) => entry.status.changedFiles))]);
      const artifacts: Array<{ artifact: ReviewerArtifact; path: string }> = [];

      await this.logger.write({
        type: "review_started",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}`,
        payload: { prUrls: reviewTargetUrls, reviewers }
      });

      for (const reviewer of reviewers) {
        const artifactRelativePath = reviewArtifactRelativePath(issue.identifier, iteration, reviewer);
        const workspaceArtifactPath = join(workspace.path, artifactRelativePath);
        const canonicalArtifactPath = reviewArtifactPath(repoRoot, issue.identifier, iteration, reviewer);
        const prompt = reviewerPrompt({
          issue,
          prUrl: reviewPr,
          reviewTargets: reviewTargetUrls,
          iteration,
          reviewer,
          artifactPath: artifactRelativePath,
          githubSummary: githubContext.summary,
          feedbackSummary: githubContext.feedback
        });
        const result = await this.runner.run({
          issue,
          prompt,
          attempt,
          workspace,
          config: readOnlyReviewConfig(this.config, workspaceReviewDir),
          signal,
          onEvent: (event) => {
            this.markRunningActivity(issue.id, event.timestamp);
            void this.logger.write({ ...event, type: `review_${event.type}` });
          }
        });
        if (result.status !== "succeeded") {
          await this.logger.write({
            type: "review_runner_failed",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: `${reviewer}: ${result.error ?? result.status}`
          });
        }
        const artifact = await readReviewArtifact(workspaceArtifactPath, reviewer);
        await writeReviewArtifact(canonicalArtifactPath, artifact);
        artifacts.push({ artifact, path: canonicalArtifactPath });
        for (const finding of artifact.findings) {
          await this.logger.write({
            type: "review_finding",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: finding.body,
            payload: finding
          });
        }
      }

      const validationFinding = validationEvidenceFinding(latestState?.validation);
      const findings = [
        ...artifacts.flatMap((entry) => entry.artifact.findings),
        ...githubContext.entries.flatMap((entry) => reviewCheckFindings(entry.status, this.config, entry.checkDiagnostics)),
        ...(validationFinding ? [validationFinding] : [])
      ];
      for (const finding of findings.filter((finding) => finding.reviewer === "checks")) {
        await this.logger.write({
          type: "review_finding",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: finding.body,
          payload: finding
        });
      }
      const blocking = blockingFindings(findings, this.config);
      const currentBlockingHashes = new Set(blocking.map((finding) => finding.findingHash));
      const resolvedFindingHashes = [
        ...(latestState?.resolvedFindingHashes ?? []),
        ...blockingFindings(previousFindings, this.config)
          .map((finding) => finding.findingHash)
          .filter((hash) => !currentBlockingHashes.has(hash))
      ];
      const reviewerStates: ReviewStateReviewer[] = artifacts.map((entry) => ({
        name: entry.artifact.reviewer,
        decision: entry.artifact.decision,
        iteration,
        artifactPath: entry.path
      }));
      const humanRequired = artifacts.some((entry) => entry.artifact.decision === "human_required") || findings.some((finding) => finding.decision === "human_required");
      const allRequiredApproved = this.config.review.requiredReviewers.every((reviewer) =>
        artifacts.some((entry) => entry.artifact.reviewer === reviewer && entry.artifact.decision === "approved")
      );
      const repeated = repeatedBlockingHashes(previousFindings, findings, this.config);
      const status: ReviewStatus = humanRequired ? "human_required" : blocking.length > 0 || !allRequiredApproved ? "changes_requested" : "approved";

      latestState = await this.recordIssueState(issue, {
        phase: "review",
        reviewIteration: iteration,
        reviewStatus: status,
        reviewers: reviewerStates,
        findings,
        resolvedFindingHashes: [...new Set(resolvedFindingHashes)],
        headSha: joinedHeadShas(githubContext.entries),
        lastReviewedSha: joinedHeadShas(githubContext.entries),
        reviewTargetMode,
        reviewTargetUrls
      });

      await this.logger.write({
        type: status === "approved" ? "review_approved" : "review_iteration_complete",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}: ${status}`,
        payload: { blocking: blocking.length, repeated }
      });

      if (status === "approved") {
        await this.commentIssue(
          issue,
          [
            "### AgentOS automated review approved",
            "",
            "Required Wiggum reviewers approved this PR.",
            "",
            reviewTargetList,
            `- Iteration: ${iteration}`,
            `- Reviewers: ${reviewerStates.map((reviewer) => `${reviewer.name}=${reviewer.decision}`).join(", ")}`
          ].join("\n")
        );
        return latestState;
      }

      if (humanRequired || repeated.length > 0 || iteration >= this.config.review.maxIterations) {
        const reason = humanRequired
          ? "a reviewer requested human judgment"
          : repeated.length > 0
            ? "the same blocking finding repeated after a fix"
            : "maximum review iterations reached";
        latestState = await this.recordIssueState(issue, { phase: "review", reviewStatus: "human_required", findings });
        await this.commentIssue(
          issue,
          [
            "### AgentOS automated review needs human judgment",
            "",
            `The Wiggum loop stopped because ${reason}.`,
            "",
            reviewTargetList,
            `- Iteration: ${iteration}`,
            "",
            "Blocking findings:",
            formatFindings(blocking, resolve(this.options.repoRoot), { includeLogExcerpts: false })
          ].join("\n")
        );
        await this.logger.write({
          type: "review_human_required",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: reason,
          payload: { findings: blocking, repeated, prUrls: reviewTargetUrls }
        });
        return latestState;
      }

      await this.logger.write({
        type: "review_fix_started",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}`,
        payload: { findings: blocking }
      });
      await this.commentIssue(
        issue,
        [
          "### AgentOS automated review requested fixes",
          "",
          "Blocking findings were found. AgentOS is running a focused fix turn on the existing PR.",
          "",
          reviewTargetList,
          `- Iteration: ${iteration}`,
          "",
          formatFindings(blocking, resolve(this.options.repoRoot), { includeLogExcerpts: false })
        ].join("\n")
      );
      await this.recordIssueState(issue, { phase: "fix", reviewStatus: "changes_requested" });
      const fixResult = await this.runner.run({
        issue,
        prompt: fixPrompt({
          issue,
          prUrl: reviewPr,
          reviewTargets: reviewTargetUrls,
          iteration,
          findings: blocking,
          handoffPath: join(workspace.path, ".agent-os", `handoff-${issue.identifier}.md`),
          feedbackSummary: githubContext.feedback
        }),
        attempt,
        workspace,
        config: this.config,
        signal,
        onEvent: (event) => {
          this.markRunningActivity(issue.id, event.timestamp);
          void this.logger.write({ ...event, type: `review_fix_${event.type}` });
        }
      });
      if (fixResult.status !== "succeeded") {
        latestState = await this.recordIssueState(issue, {
          phase: "fix",
          reviewStatus: "human_required",
          lastError: fixResult.error ?? fixResult.status,
          errorCategory: "fix"
        });
        await this.commentIssue(issue, `### AgentOS review fix failed\n\nThe fixer turn did not complete successfully.\n\n- PR: ${reviewPr}\n- Error: ${fixResult.error ?? fixResult.status}`);
        return latestState;
      }
      const updatedHandoff = await readHandoff(workspace.path, issue.identifier);
      if (updatedHandoff) {
        const handoffPrUrls = extractPullRequestUrls(updatedHandoff);
        try {
          await assertPullRequestUrlsMatchRepo(resolve(this.options.repoRoot), handoffPrUrls);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const finding = handoffPullRequestValidationFinding(message);
          latestState = await this.recordIssueState(issue, {
            phase: "review",
            reviewStatus: "human_required",
            lastError: message,
            errorCategory: "review",
            findings: [finding]
          });
          await this.commentIssue(
            issue,
            [
              "### AgentOS automated review needs human judgment",
              "",
              "The focused fixer handoff contained pull request metadata that AgentOS could not validate against the current repository.",
              "",
              `- Error: ${message}`,
              "",
              "Blocking findings:",
              formatFindings([finding], resolve(this.options.repoRoot), { includeLogExcerpts: false })
            ].join("\n")
          );
          await this.logger.write({
            type: "review_human_required",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message,
            payload: { findings: [finding], prUrls: handoffPrUrls }
          });
          return latestState;
        }
        const updated = issueStateFromHandoff(issue, updatedHandoff);
        if (updated) {
          latestState = await new IssueStateStore(resolve(this.options.repoRoot)).merge(issue.identifier, {
            ...updated,
            phase: "fix",
            reviewIteration: iteration,
            lastFixedSha: joinedHeadShas(githubContext.entries),
            reviewTargetMode
          });
        }
      }
      previousFindings = findings;
    }
    return latestState;
  }

  private async recordReviewTargetSelectionFailure(issue: Issue, state: IssueState, reviewTargetMode: ReviewTargetMode): Promise<IssueState> {
    const recordedPrUrls = pullRequestUrls(state);
    const error = reviewTargetSelectionError(state, reviewTargetMode);
    const latestState = await this.recordIssueState(issue, {
      phase: "review",
      reviewStatus: "human_required",
      lastError: error,
      errorCategory: "review",
      reviewTargetMode,
      reviewTargetUrls: []
    });
    await this.commentIssue(
      issue,
      [
        "### AgentOS automated review needs human judgment",
        "",
        "AgentOS could not select a pull request target for automated review.",
        "",
        `- Review target mode: ${reviewTargetMode}`,
        formatRecordedPullRequests(state),
        `- Error: ${error}`
      ].join("\n")
    );
    await this.logger.write({
      type: "review_human_required",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: error,
      payload: { prUrls: recordedPrUrls, reviewTargetMode }
    });
    return latestState;
  }

  private reviewersFor(changedFiles: string[]): string[] {
    const reviewers = [...this.config.review.requiredReviewers];
    const securityNeeded = changedFiles.some((file) => /(^|\/)(auth|security|secrets?|config|env|api|github|linear|runner|orchestrator)/i.test(file));
    for (const reviewer of this.config.review.optionalReviewers) {
      if (reviewer === "security" && !securityNeeded) continue;
      if (!reviewers.includes(reviewer)) reviewers.push(reviewer);
    }
    return reviewers;
  }

  private async githubReviewContext(targets: PullRequestRef[]): Promise<{
    entries: Array<{
      target: PullRequestRef;
      status: Awaited<ReturnType<GitHubClient["getPullRequest"]>>;
      checkDiagnostics: Awaited<ReturnType<GitHubClient["getFailingCheckDiagnostics"]>>;
    }>;
    summary: string;
    feedback: string;
  }> {
    const github = new GitHubClient(this.config.github.command);
    const cwd = resolve(this.options.repoRoot);
    const entries = [];
    const summaries: string[] = [];
    const feedback: string[] = [];
    for (const target of targets) {
      const status = await github.getPullRequest(target.url, cwd);
      const checkDiagnostics = await github.getFailingCheckDiagnostics(status, cwd);
      const diff = await github.getPullRequestDiff(target.url, cwd).catch((error: Error) => `Could not fetch diff: ${error.message}`);
      const threads = await github.getPullRequestReviewThreads(target.url, cwd).catch(() => []);
      entries.push({ target, status, checkDiagnostics });
      summaries.push([`## PR ${target.url}`, `Role: ${target.role ?? "supporting"}`, summarizePullRequestForPrompt(status, diff, threads, checkDiagnostics)].join("\n"));
      const targetFeedback = summarizeFeedback(status, threads);
      if (targetFeedback) feedback.push([`## PR ${target.url}`, targetFeedback].join("\n"));
    }
    return {
      entries,
      summary: summaries.join("\n\n---\n\n"),
      feedback: feedback.join("\n\n---\n\n")
    };
  }

  private async shepherdMergeIssue(issue: Issue): Promise<void> {
    const stateStore = new IssueStateStore(resolve(this.options.repoRoot));
    const state = await stateStore.read(issue.identifier);
    const mergeTarget = mergeTargetPullRequest(state);
    const mergePr = mergeTarget?.url ?? null;
    const mergeEligiblePrs = mergeEligiblePullRequests(state);
    if (state && !mergePr && isNoPrHandoffApproved(state) && mergeEligiblePrs.length === 0) {
      await this.commentIssue(
        issue,
        [
          "### AgentOS merge shepherd",
          "",
          "No merge-eligible pull request output was selected for this issue. Treating the Linear `Merging` move as approval of the handoff without a merge.",
          "",
          state.prs?.length ? formatPullRequestTargets(state.prs) : "- PRs: none",
          "- Result: moving issue to Done"
        ].join("\n")
      );
      await this.moveIssue(issue, this.config.github.doneState);
      await this.logger.write({
        type: "merge_no_pr_succeeded",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: "approved no-PR handoff"
      });
      return;
    }
    if (state && !mergePr && mergeEligiblePrs.length > 0) {
      await this.markMergeFailed(issue, mergeTargetAmbiguityReason(state) ?? "Merge target selection is ambiguous; select exactly one primary PR before merging.");
      return;
    }
    if (!state || !mergePr) {
      await this.markMergeFailed(issue, "No pull request metadata was found for this issue.");
      return;
    }

    await this.logger.write({
      type: "merge_shepherd_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: mergePr,
      payload: { prUrl: mergePr, role: mergeTarget?.role ?? "primary", mergeTarget: this.config.github.mergeTarget ?? "primary" }
    });

    const github = new GitHubClient(this.config.github.command);
    try {
      const repoRoot = resolve(this.options.repoRoot);
      await assertPullRequestUrlMatchesRepo(repoRoot, mergePr);
      const pr = await github.getPullRequest(mergePr, repoRoot);
      await stateStore.merge(issue.identifier, {
        ...state,
        mergeTargetUrl: mergePr,
        mergeTargetRole: mergeTarget?.role ?? "primary",
        updatedAt: new Date().toISOString()
      });
      if (pr.merged) {
        const cleanupWarnings = await this.cleanupMergedPullRequest(issue, github, pr);
        await this.recordIssueState(issue, {
          phase: "completed",
          lifecycleStatus: "already_merged_pr",
          mergedAt: new Date().toISOString(),
          nextRetryAt: undefined,
          retryAttempt: undefined,
          stopReason: undefined
        });
        await this.runtimeState.clearIssue(issue.id);
        await this.commentIssue(issue, `### AgentOS merge shepherd\n\nPull request is already merged. Treating that as authoritative and completing the issue.\n\n- PR: ${mergePr}${cleanupWarnings.length ? `\n\nCleanup warnings:\n${cleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`);
        await this.moveIssue(issue, this.config.github.doneState);
        return;
      }

      if (this.config.review.enabled && state.reviewStatus !== "approved") {
        if (!this.config.github.allowHumanMergeOverride) {
          await this.markMergeFailed(issue, `automated review is not approved (reviewStatus=${state.reviewStatus ?? "missing"})`, mergePr);
          return;
        }
        if (!state.humanOverrideAt) {
          const overrideAt = new Date().toISOString();
          await new IssueStateStore(resolve(this.options.repoRoot)).merge(issue.identifier, {
            ...state,
            humanOverrideAt: overrideAt,
            humanContinuationAt: overrideAt,
            lifecycleStatus: "human_continuation",
            updatedAt: overrideAt
          });
          await this.commentIssue(
            issue,
            [
              "### AgentOS review override recorded",
              "",
              "This issue is in `Merging` before automated review approval. Treating the Linear status move as explicit human approval for this merge attempt.",
              "",
              `- PR: ${mergePr}`,
              `- Previous reviewStatus: ${state.reviewStatus ?? "missing"}`
            ].join("\n")
          );
          await this.logger.write({
            type: "review_human_override",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: state.reviewStatus ?? "missing",
            payload: { prUrl: mergePr }
          });
        }
        const validationFresh = state.validation?.status === "passed" || state.validation?.finalStatus === "passed";
        if (!validationFresh) {
          await this.markMergeFailed(issue, "human continuation requires fresh passing validation evidence before merge progression", mergePr);
          return;
        }
      }

      const readiness = evaluateMergeReadiness(pr, this.config.github.requireChecks);
      if (!readiness.ready) {
        if (readiness.reason.includes("pending")) {
          await this.markMergeWaiting(issue, mergePr, readiness.reason);
        } else {
          await this.markMergeFailed(issue, readiness.reason, mergePr);
        }
        return;
      }

      await this.commentIssue(issue, `### AgentOS merge shepherd\n\nChecks are green and the pull request is mergeable. Starting ${this.config.github.mergeMethod} merge.\n\n- PR: ${mergePr}`);
      await github.mergePullRequest(mergePr, this.config.github, repoRoot);
      const cleanupWarnings = await this.cleanupMergedPullRequest(issue, github, pr);
      await this.recordIssueState(issue, {
        phase: "completed",
        lifecycleStatus: cleanupWarnings.length ? "post_merge_cleanup_warning" : "merge_success",
        mergedAt: new Date().toISOString(),
        nextRetryAt: undefined,
        retryAttempt: undefined,
        stopReason: undefined
      });
      await this.runtimeState.clearIssue(issue.id);
      await this.commentIssue(issue, `### AgentOS merge complete\n\nMerged successfully.\n\n- PR: ${mergePr}\n- Method: ${this.config.github.mergeMethod}${cleanupWarnings.length ? `\n\nCleanup warnings:\n${cleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`);
      await this.moveIssue(issue, this.config.github.doneState);
      await this.logger.write({
        type: cleanupWarnings.length ? "merge_succeeded_with_cleanup_warnings" : "merge_succeeded",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: mergePr,
        payload: cleanupWarnings.length ? { cleanupWarnings } : undefined
      });
    } catch (error) {
      await this.markMergeFailed(issue, error instanceof Error ? error.message : String(error), mergePr);
    }
  }

  private async cleanupMergedPullRequest(issue: Issue, github: GitHubClient, pr: Awaited<ReturnType<GitHubClient["getPullRequest"]>>): Promise<string[]> {
    const warnings: string[] = [];
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    await workspaceManager.remove(issue.identifier).catch((error: Error) => {
      warnings.push(`Workspace cleanup failed for ${issue.identifier}: ${error.message}`);
    });
    const cleanup = await github.cleanupMergedPullRequest(pr, this.config.github, resolve(this.options.repoRoot));
    warnings.push(...cleanup.warnings);
    if (warnings.length > 0) {
      await this.recordIssueState(issue, {
        mergeCleanupWarnings: warnings,
        lifecycleStatus: "post_merge_cleanup_warning"
      });
      await this.logger.write({
        type: "merge_cleanup_warning",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: warnings.join("; "),
        payload: { warnings }
      });
    }
    return warnings;
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

  private markRunningActivity(issueId: string, timestamp = new Date().toISOString()): void {
    const running = this.running.get(issueId);
    if (running) {
      running.lastCodexEventAt = Date.now();
      void this.runtimeState.patchActiveRun(issueId, { lastEventAt: timestamp });
    }
  }

  private async handleTerminalStoppedRun(issue: Issue, reason: string, runId: string): Promise<void> {
    const states = await this.tracker.fetchIssueStates([issue.id]).catch(() => null);
    const fetched = states?.get(issue.id);
    const latest = fetched ?? issue;
    if (fetched === null) {
      await this.recordIssueState(issue, {
        phase: "canceled",
        lastRunId: runId,
        lastError: reason,
        errorCategory: "canceled",
        stopReason: reason,
        nextRetryAt: undefined,
        retryAttempt: undefined
      });
      await this.runtimeState.clearIssue(issue.id);
    } else if (isStateIn(latest.state, this.config.tracker.terminalStates)) {
      await this.classifyTerminalIssue(latest, reason);
    } else {
      const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(issue.identifier);
      if (!(await this.classifyAlreadyMergedIssue(latest, state, reason))) {
        await this.recordIssueState(latest, {
          phase: "human-required",
          lastRunId: runId,
          lastError: reason,
          errorCategory: "canceled",
          stopReason: reason,
          nextRetryAt: undefined,
          retryAttempt: undefined
        });
        await this.runtimeState.clearIssue(latest.id);
      }
    }
    await this.writeRunEvent(runId, {
      type: "run_skipped_terminal",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason
    });
  }

  private async handleFailedRun(issue: Issue, workspace: Workspace, previousAttempt: number | null, error: string, runId: string): Promise<void> {
    if (isHumanInputStop(error)) {
      this.completedMarkers.set(issue.id, completionMarker(issue));
      await this.writeRunEvent(runId, {
        type: "run_needs_human_input",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: error,
        payload: { errorCategory: "human-input" }
      });
      await this.recordIssueState(issue, {
        phase: "needs-input",
        lastError: error,
        errorCategory: "human-input",
        stopReason: error,
        nextRetryAt: undefined,
        retryAttempt: undefined
      });
      await this.markLinearNeedsInput(issue, workspace, previousAttempt, error);
      return;
    }
    const nextAttempt = previousAttempt == null ? 1 : previousAttempt + 1;
    if (nextAttempt > this.config.agent.maxRetryAttempts) {
      await this.recordIssueState(issue, {
        lastError: error,
        errorCategory: categorizeRunError(error),
        lifecycleStatus: "implementation_failure",
        stopReason: error,
        nextRetryAt: undefined
      });
      await this.markLinearFailed(issue, workspace, previousAttempt, error);
      return;
    }
    const retry = await this.scheduleRetry(issue, previousAttempt, error, undefined, runId, workspace);
    await this.recordIssueState(issue, {
      lastError: error,
      errorCategory: categorizeRunError(error),
      lifecycleStatus: "implementation_failure",
      stopReason: error,
      retryAttempt: retry.attempt,
      nextRetryAt: new Date(retry.dueAtMs).toISOString()
    });
    await this.markLinearRetryScheduled(issue, workspace, retry);
  }

  private async scheduleRetry(issue: Issue, previousAttempt: number | null, error: string | null, overrideDelayMs?: number, runId?: string, workspace?: Workspace): Promise<RetryEntry> {
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
    await this.runtimeState.upsertRetry({
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt,
      dueAt: new Date(retry.dueAtMs).toISOString(),
      error,
      errorCategory: error ? categorizeRunError(error) : undefined,
      scheduledAt: new Date().toISOString(),
      runId,
      workspacePath: workspace?.path,
      workspaceKey: workspace?.workspaceKey
    });
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
      ].join("\n"),
      "run_started"
    );
  }

  private async markLinearSucceeded(issue: Issue, workspace: Workspace, handoff: string | null, state?: IssueState): Promise<void> {
    await this.recordIssueState(issue, {
      phase: "completed",
      activeRunId: undefined,
      nextRetryAt: undefined,
      retryAttempt: undefined,
      stopReason: undefined,
      ...(state?.reviewStatus === "human_required"
        ? {}
        : {
            lastError: undefined,
            errorCategory: undefined
          })
    });
    const reviewLine = state?.reviewStatus
      ? `\n\nAutomated review status: \`${state.reviewStatus}\`${state.reviewIteration ? ` after iteration ${state.reviewIteration}` : ""}.`
      : "";
    if (usesFullOrchestratorHandoff(this.config)) {
      await this.commentIssue(
        issue,
        handoff
          ? `${handoff}${reviewLine}`
          : [
              "### AgentOS handoff",
              "",
              "Codex completed this run successfully, but no handoff file was found.",
              "",
              `- Workspace: \`${workspace.path}\``,
              "- Expected validation: project harness check",
              reviewLine.trim()
            ].join("\n"),
        "run_handoff",
        "substantive"
      );
    } else {
      await this.commentIssue(
        issue,
        hybridHandoffComment({
          issueIdentifier: issue.identifier,
          workspacePath: workspace.path,
          reviewStatus: state?.reviewStatus,
          reviewIteration: state?.reviewIteration
        }),
        "run_handoff"
      );
    }
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
      ].join("\n"),
      "retry_scheduled"
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
      ].join("\n"),
      "run_failed"
    );
    await this.moveIssue(issue, this.config.tracker.needsInputState);
  }

  private async markLinearNeedsInput(issue: Issue, workspace: Workspace, attempt: number | null, error: string): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS needs human input",
        "",
        "Codex requested elicitation, approval, user input, or interactive confirmation. Current policy denies those requests by default, so AgentOS stopped the run instead of waiting indefinitely.",
        "",
        `- Attempt: ${displayAttempt(attempt)}`,
        `- Workspace: \`${workspace.path}\``,
        `- Error: ${error}`,
        "",
        "Please handle the requested input manually before returning this issue to an active state."
      ].join("\n"),
      "run_needs_input"
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
      ].join("\n"),
      "merge_waiting"
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
        .join("\n"),
      "merge_failed"
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

  private async recordIssueState(issue: Issue, patch: Partial<IssueState>): Promise<IssueState> {
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).merge(issue.identifier, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      ...patch
    });
    const activePatch: Partial<RuntimeActiveRun> = {};
    if (patch.phase) activePatch.phase = patch.phase;
    if (patch.stopReason !== undefined) activePatch.stopReason = patch.stopReason;
    if (patch.lastCodexEventAt) activePatch.lastEventAt = patch.lastCodexEventAt;
    if (patch.workspacePath !== undefined) activePatch.workspacePath = patch.workspacePath;
    if (patch.workspaceKey !== undefined) activePatch.workspaceKey = patch.workspaceKey;
    if (Object.keys(activePatch).length > 0) {
      await this.runtimeState.patchActiveRun(issue.id, activePatch);
    }
    return state;
  }

  private async moveIssue(issue: Issue, stateName: string | null): Promise<void> {
    if (!stateName || !this.tracker.move || !orchestratorMayMoveIssue(this.config)) return;
    await this.tracker.move(issue.identifier, stateName).catch((error: Error) =>
      this.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `move to ${stateName}: ${error.message}`
      })
    );
  }

  private async commentIssue(issue: Issue, body: string, key?: string, kind: "bookkeeping" | "substantive" = "bookkeeping"): Promise<void> {
    if (!orchestratorMayComment(this.config, kind)) return;
    if (!this.tracker.comment && !this.tracker.upsertComment) return;
    const safeBody = redactText(key ? `${linearCommentMarker(key, issue.identifier)}\n${body}` : body);
    const operation =
      key && this.tracker.upsertComment
        ? this.tracker.upsertComment(issue.identifier, safeBody, linearCommentKey(key, issue.identifier))
        : this.tracker.comment!(issue.identifier, safeBody);
    await operation.catch((error: Error) =>
      this.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `comment: ${error.message}`
      })
    );
  }
}

function isNoPrHandoffApproved(state: IssueState): boolean {
  return state.phase === "completed" && (state.validation?.finalStatus === "passed" || state.validation?.status === "passed");
}

function linearCommentKey(event: string, issueIdentifier: string): string {
  return `${event}:${issueIdentifier}`;
}

function linearCommentMarker(event: string, issueIdentifier: string): string {
  return `<!-- agentos:event=${linearCommentKey(event, issueIdentifier)} -->`;
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

function formatPullRequestTargets(targets: PullRequestRef[]): string {
  if (targets.length === 0) return "- PRs: none";
  if (targets.length === 1) return `- PR: ${targets[0].url} (${targets[0].role ?? "supporting"})`;
  return ["- PRs:", ...targets.map((target) => `  - ${target.url} (${target.role ?? "supporting"})`)].join("\n");
}

function formatRecordedPullRequests(state: IssueState): string {
  if (state.prs?.length) return formatPullRequestTargets(state.prs);
  const urls = pullRequestUrls(state);
  if (urls.length === 0) return "- PRs: none";
  if (urls.length === 1) return `- PR: ${urls[0]}`;
  return ["- PRs:", ...urls.map((url) => `  - ${url}`)].join("\n");
}

function reviewTargetSelectionError(state: IssueState, reviewTargetMode: ReviewTargetMode): string {
  if (reviewTargetMode === "primary") {
    const primaryCount = state.prs?.filter((pr) => pr.role === "primary").length ?? 0;
    if (primaryCount === 0) return "review.target_mode=primary requires exactly one primary PR, but no primary PR was recorded.";
    return `review.target_mode=primary requires exactly one primary PR, but ${primaryCount} primary PRs were recorded.`;
  }
  return "review.target_mode=merge-eligible requires at least one primary or docs PR, but no merge-eligible PR was recorded.";
}

function joinedHeadShas(entries: Array<{ status: Awaited<ReturnType<GitHubClient["getPullRequest"]>> }>): string | null {
  const shas = [...new Set(entries.map((entry) => entry.status.headSha).filter((sha): sha is string => Boolean(sha)))];
  return shas.length ? shas.join(",") : null;
}

function readOnlyReviewConfig(config: ServiceConfig, reviewWritableRoot: string): ServiceConfig {
  return {
    ...config,
    codex: {
      ...config.codex,
      approvalEventPolicy: "deny",
      userInputPolicy: "deny",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite", writableRoots: [reviewWritableRoot], networkAccess: false }
    }
  };
}

function reviewCheckFindings(
  status: Awaited<ReturnType<GitHubClient["getPullRequest"]>>,
  config: ServiceConfig,
  diagnostics: Awaited<ReturnType<GitHubClient["getFailingCheckDiagnostics"]>> = []
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (status.checkSummary.failing > 0) {
    const mechanical = diagnostics.filter((diagnostic) => diagnostic.classification === "mechanical");
    const humanRequired = diagnostics.filter((diagnostic) => diagnostic.classification === "human_required");
    const capabilities = trustCapabilities(config.trustMode);
    const canRunMechanicalCiFix = config.automation.repairPolicy === "mechanical-first" && capabilities.prNetwork;
    if (mechanical.length > 0 && canRunMechanicalCiFix) {
      findings.push({
        reviewer: "checks",
        decision: "changes_requested" as const,
        severity: "P1" as const,
        file: null,
        line: null,
        body: `${mechanical.length} GitHub check(s) failed mechanically with logs available. Run a bounded CI fix before Human Review.\n\n${summarizeCheckDiagnostics(mechanical)}`,
        findingHash: `checks-failing-mechanical-${checkDiagnosticFingerprint(mechanical)}`
      });
    }
    if (humanRequired.length > 0 || mechanical.length === 0 || !canRunMechanicalCiFix) {
      const unresolved = humanRequired.length > 0 ? humanRequired : diagnostics.length > 0 ? diagnostics : [];
      const reason =
        config.automation.repairPolicy !== "mechanical-first"
          ? "automation.repair_policy is conservative, so CI repair is not attempted automatically."
          : !capabilities.prNetwork
            ? `trust_mode=${config.trustMode} does not allow PR/network capability, so CI repair is not attempted automatically.`
            : "AgentOS could not classify the failed check as a mechanical failure with enough context.";
      findings.push({
        reviewer: "checks",
        decision: "human_required" as const,
        severity: "P1" as const,
        file: null,
        line: null,
        body: `${status.checkSummary.failing} GitHub check(s) failed. ${reason}\n\n${unresolved.length > 0 ? summarizeCheckDiagnostics(unresolved) : "No failed check logs were available."}`,
        findingHash: `checks-failing-human-${unresolved.length > 0 ? checkDiagnosticFingerprint(unresolved) : status.checkSummary.failing}`
      });
    }
  }
  if (config.github.requireChecks && status.checkSummary.total === 0) {
    findings.push({
      reviewer: "checks",
      decision: "changes_requested" as const,
      severity: "P1" as const,
      file: null,
      line: null,
      body: "No GitHub checks are present. The Wiggum loop requires at least one successful check or a human escalation.",
      findingHash: "checks-missing"
    });
  }
  if (config.github.requireChecks && status.checkSummary.total > 0 && status.checkSummary.failing === 0 && status.checkSummary.successful === 0 && status.checkSummary.pending === 0) {
    findings.push({
      reviewer: "checks",
      decision: "changes_requested" as const,
      severity: "P1" as const,
      file: null,
      line: null,
      body: "No successful GitHub checks are present.",
      findingHash: "checks-no-success"
    });
  }
  return findings;
}

function handoffPullRequestValidationFinding(message: string): ReviewFinding {
  const body = `Focused fixer handoff PR metadata failed current-repository validation before state merge: ${message}`;
  return {
    reviewer: "handoff",
    decision: "human_required",
    severity: "P1",
    file: null,
    line: null,
    body,
    findingHash: createHash("sha256").update(`handoff-pr-validation\n${body}`).digest("hex").slice(0, 16)
  };
}

function checkDiagnosticFingerprint(diagnostics: Awaited<ReturnType<GitHubClient["getFailingCheckDiagnostics"]>>): string {
  const stable = diagnostics
    .map((diagnostic) =>
      [
        diagnostic.check.name,
        diagnostic.check.status ?? "",
        diagnostic.check.conclusion ?? "",
        diagnostic.classification,
        diagnostic.reason,
        diagnostic.log ? singleLine(diagnostic.log).slice(0, 1200) : ""
      ].join("\n")
    )
    .sort()
    .join("\n---\n");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function validationFailureMessage(validation: NonNullable<IssueState["validation"]>): string {
  const reason = validation.errors?.length ? validation.errors.join("; ") : `status=${validation.status}`;
  return `validation_failed: ${reason}`;
}

function runtimeRetryToMemory(retry: RuntimeRetryEntry): RetryEntry {
  const due = Date.parse(retry.dueAt);
  return {
    issueId: retry.issueId,
    identifier: retry.identifier,
    issue: retry.issue,
    attempt: retry.attempt,
    dueAtMs: Number.isFinite(due) ? due : Date.now(),
    error: retry.error
  };
}

function issueFromState(state: IssueState): Issue {
  return {
    id: state.issueId,
    identifier: state.issueIdentifier,
    title: state.issueIdentifier,
    description: null,
    priority: null,
    state: state.terminalState ?? "",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: state.updatedAt
  };
}

function issueFromRunSummary(summary: RunSummary): Issue {
  return {
    id: summary.issueId,
    identifier: summary.issueIdentifier,
    title: summary.issueIdentifier,
    description: null,
    priority: null,
    state: "",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: summary.startedAt
  };
}

function workspaceFromRuntime(active: RuntimeActiveRun, summary: RunSummary | undefined, workspaceRoot: string): Workspace {
  const workspaceKey = active.workspaceKey ?? active.identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    path: active.workspacePath ?? summary?.workspacePath ?? join(workspaceRoot, workspaceKey),
    workspaceKey,
    createdNow: false
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isDispatchTerminalStop(error: string | undefined): boolean {
  return Boolean(
    error?.startsWith("issue_became_terminal:") ||
      error?.startsWith("issue_no_longer_dispatchable:") ||
      error === "issue_no_longer_exists" ||
      error === "pull_request_already_merged"
  );
}

function categorizeRunError(message: string): RunErrorCategory {
  const normalized = message.toLowerCase();
  if (isHumanInputStop(normalized)) return "human-input";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("stall")) return "stall";
  if (normalized.includes("cancel")) return "canceled";
  if (normalized.includes("workspace") || normalized.includes("worktree")) return "workspace";
  if (normalized.includes("prompt") || normalized.includes("liquid")) return "prompt";
  if (normalized.includes("app_server") || normalized.includes("app-server") || normalized.includes("initialize")) return "app-server-init";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("fix")) return "fix";
  if (normalized.includes("validation") || normalized.includes("test") || normalized.includes("check")) return "validation";
  return "streaming-turn";
}

function isHumanInputStop(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("codex_approval_request_denied") ||
    normalized.includes("codex_user_input_request_denied") ||
    normalized.includes("codex_elicitation_request_denied") ||
    normalized.includes("agent_pr_creation_failed") ||
    normalized.includes("nested_orchestrator_forbidden")
  );
}

async function readHandoff(workspacePath: string, identifier: string): Promise<string | null> {
  const path = join(workspacePath, ".agent-os", `handoff-${identifier}.md`);
  if (!(await exists(path))) return null;
  const text = await readText(path);
  return text.trim() ? text : null;
}

function gitRevParse(cwd: string, ref: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", cwd, "rev-parse", ref], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => resolvePromise(code === 0 ? stdout.trim() || null : null));
  });
}
