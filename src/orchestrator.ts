import { join, resolve } from "node:path";
import { exists } from "./fs-utils.js";
import { daemonPreflight, preflightAllowsDispatch, resolveRepoEnv, type DaemonPreflightResult, type RepoEnvLoadResult } from "./env.js";
import { evaluateMergeReadiness, GitHubClient, summarizeFeedback, type PullRequestStatus } from "./github.js";
import { readGitHubReviewContext } from "./github-context.js";
import { assertPullRequestUrlMatchesRepo, assertPullRequestUrlsMatchRepo } from "./github-repository.js";
import { extractPullRequestUrls, extractHumanDecisionsFromComments, hasHumanDecision, isAuthoritativeHumanDecision, latestAuthoritativeHumanDecision, latestIssueComments, issueStateFromHandoff, IssueStateStore, latestHumanDecision, mergeHumanDecisions, reconcileHumanDecisionsForFetchedComments, mergeEligiblePullRequests, mergeTargetAmbiguityReason, mergeTargetPullRequest, primaryPullRequestUrl, pullRequestUrls, reviewTargetPullRequests } from "./issue-state.js";
import { hybridHandoffComment, orchestratorMayComment, orchestratorMayMoveIssue, usesFullOrchestratorHandoff } from "./lifecycle.js";
import { JsonlLogger } from "./logging.js";
import { LinearClient } from "./linear.js";
import { summarizeText } from "./output-capture.js";
import { persistPhaseTimingToRun, phaseTimingLogPayload, timingStartNoLaterThan, timingStatusForRunResult, validationTimingFromEvidence, type PhaseTimingEventInput } from "./phase-timing.js";
import { buildTargetedContextPack, pullRequestContextEntriesForUrls, pullRequestRefsForUrls } from "./context-pack.js";
import { existingImplementationAuditContext } from "./prompt-context.js";
import { formatRecoveryDiagnostics, inspectWorkspaceRecovery, type WorkspaceRecoveryDiagnostics } from "./recovery.js";
import { redactText } from "./redaction.js";
import { readRuntimeRetryForIssue, retryBackoffFinishMetadata, runtimeRetryToMemory, type RetryEntry } from "./orchestrator-retry.js";
import { safeGuardrailErrorMessage } from "./orchestrator-guardrail-errors.js";
import { formatPullRequestTargets, formatRecordedPullRequests, handoffPullRequestValidationFinding, joinedHeadShas, reviewCheckFindings, reviewTargetSelectionError } from "./orchestrator-review-helpers.js";
import { gitRevParse, issueFromRunSummary, issueFromState, readHandoff, uniqueStrings, validationFailureMessage, workspaceFromRuntime } from "./orchestrator-state-helpers.js";
import { allowsImplementationContinuation, formatHumanDecision, formatLinearComment, GUARDRAIL_LINEAR_COMMENT_LIMIT, linearCommentKey, linearCommentMarker, RECENT_LINEAR_COMMENT_LIMIT } from "./orchestrator-human-decisions.js";
import { alreadyMergedIssuePatch, terminalHeadPatch, terminalWaitPhaseFinishes, terminalWorkspaceWarning } from "./orchestrator-terminal.js";
import { isConfiguredReviewDispatchStop, reviewStateBlocksTrackerUpdate, trackerDispatchStop, type TrackerUpdateResult } from "./orchestrator-tracker-guard.js";
import { blockingFindings, ensureReviewIterationDir, fixPrompt, formatFindings, formatReviewRunnerFailures, repeatedBlockingHashes } from "./review.js";
import { reviewerConcurrencyFor, runReviewerIteration } from "./reviewer-scheduler.js";
import { categorizeRunError, isDispatchTerminalStop, isHumanInputStop } from "./run-errors.js";
import { CodexAppServerRunner } from "./runner/app-server.js";
import { RunArtifactStore, type RunPhaseTiming, type RunSummary, type RunTimingPhase, type RunTimingStatus } from "./runs.js";
import { RuntimeStateStore, type RuntimeActiveRun, type RuntimeRecoverySummary } from "./runtime-state.js";
import { logPreDispatchScopeReport, type PreDispatchScopeReport } from "./scope-report.js";
import { validationEvidenceFinding, verifyValidationEvidence } from "./validation.js";
import { loadWorkflow, renderPrompt, resolveServiceConfig, validateDispatchConfig } from "./workflow.js";
import { recoverWorkspaceLocks, WorkspaceManager } from "./workspace.js";
import type { AgentEvent, AgentRunResult, AgentRunner, HumanDecisionState, Issue, IssueComment, IssueState, IssueTracker, LifecycleStatus, ReviewFinding, ReviewRunnerFailure, ReviewStatus, ReviewTargetMode, ServiceConfig, WorkflowDefinition, Workspace } from "./types.js";
export interface OrchestratorOptions {
  repoRoot: string;
  workflowPath: string;
  tracker?: IssueTracker;
  runner?: AgentRunner;
  logger?: JsonlLogger;
  env?: NodeJS.ProcessEnv;
  maxConcurrentAgents?: number;
}

export interface OrchestratorRunOptions { dispatchLimit?: number; }

export interface OrchestratorRunSummary {
  dispatched: number;
  retryDispatched: number;
  candidateDispatched: number;
  candidates: number;
}

interface RunningEntry {
  issue: Issue;
  startedAt: number;
  runId: string | null;
  lastCodexEventAt: number | null;
  abortController: AbortController;
  promise: Promise<void>;
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
  private repoEnv: RepoEnvLoadResult | null = null;
  private preflight: DaemonPreflightResult | null = null;
  private preflightWarningMarker: string | null = null;

  constructor(private readonly options: OrchestratorOptions) {
    this.logger = options.logger ?? new JsonlLogger(resolve(options.repoRoot));
    this.runArtifacts = new RunArtifactStore(resolve(options.repoRoot));
    this.runtimeState = new RuntimeStateStore(resolve(options.repoRoot));
  }

  async reload(): Promise<void> {
    const resolvedEnv = await resolveRepoEnv(resolve(this.options.repoRoot), this.options.env ?? process.env);
    this.repoEnv = resolvedEnv.repoEnv;
    this.workflow = await loadWorkflow(this.options.workflowPath);
    this.config = resolveServiceConfig(this.workflow, resolvedEnv.env);
    this.preflight = daemonPreflight(this.config, this.repoEnv);
    if (this.options.maxConcurrentAgents != null && Number.isInteger(this.options.maxConcurrentAgents) && this.options.maxConcurrentAgents > 0) {
      this.config.agent.maxConcurrentAgents = Math.min(this.config.agent.maxConcurrentAgents, this.options.maxConcurrentAgents);
    }
    this.tracker = this.options.tracker ?? new LinearClient(this.config.tracker);
    this.runner = this.options.runner ?? new CodexAppServerRunner();
  }

  async runOnce(waitForWorkers = true, options: OrchestratorRunOptions = {}): Promise<OrchestratorRunSummary> {
    await this.reload();
    let dispatched = 0;
    let retryDispatched = 0;
    let candidateDispatched = 0;
    const remainingDispatchCapacity = (): number => {
      if (options.dispatchLimit == null) return Number.POSITIVE_INFINITY;
      return Math.max(0, options.dispatchLimit - dispatched);
    };
    await this.refreshDaemonRuntimeState();
    if (this.preflight && !preflightAllowsDispatch(this.preflight)) {
      await this.logger.write({
        type: "daemon_preflight_failed",
        message: this.preflight.message,
        payload: this.preflight
      });
      return { dispatched: 0, retryDispatched: 0, candidateDispatched: 0, candidates: 0 };
    }
    await this.reconstructStartupState();
    await this.cleanupTerminalWorkspaces();
    await this.reconcile();
    validateDispatchConfig(this.config);
    retryDispatched = await this.dispatchDueRetries(remainingDispatchCapacity());
    dispatched += retryDispatched;
    if (this.config.github.mergeMode !== "manual") {
      await this.shepherdMergingIssues();
    }
    const candidates = await this.tracker.fetchCandidates(this.config.tracker.activeStates);
    for (const issue of candidates) {
      if (remainingDispatchCapacity() <= 0) break;
      if (!this.isEligible(issue)) continue;
      if (this.running.size >= this.config.agent.maxConcurrentAgents) break;
      if (!this.hasSlot(issue.state)) continue;
      const retry = this.retries.get(issue.id);
      const prepared = await this.prepareForDispatch(issue);
      if (!prepared) { if (retry && retry.dueAtMs <= Date.now() && !this.retries.has(retry.issueId)) await this.finishRetryBackoff(retry, issue, "canceled", "retry skipped before dispatch"); continue; }
      const dueRetry = retry && retry.dueAtMs <= Date.now() ? retry : null;
      const didDispatch = await this.dispatch(prepared, dueRetry?.attempt ?? null);
      if (didDispatch) {
        if (dueRetry) await this.finishRetryBackoff(dueRetry, prepared, "completed", "retry dispatched");
        dispatched += 1;
        candidateDispatched += 1;
      } else if (dueRetry) {
        await this.finishRetryBackoff(dueRetry, prepared, "canceled", "retry skipped before dispatch");
      }
    }
    if (waitForWorkers) {
      await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
    }
    return { dispatched, retryDispatched, candidateDispatched, candidates: candidates.length };
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
    const payload = { ...entry, runId, timestamp: entry.timestamp ?? new Date().toISOString() };
    await this.logger.write(payload);
    await this.runArtifacts.writeEvent(runId, payload);
  }

  private async startRunPhase(
    runId: string,
    issue: Issue,
    phase: RunTimingPhase,
    label?: string,
    metadata?: Record<string, unknown>
  ): Promise<RunPhaseTiming> {
    const timing = await this.runArtifacts.startPhase(runId, { phase, label, metadata });
    await this.writeRunEvent(runId, {
      type: "phase_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: label ?? phase,
      timestamp: timing.startedAt,
      payload: { timing }
    });
    return timing;
  }

  private async finishRunPhase(
    runId: string,
    issue: Issue,
    timing: RunPhaseTiming,
    status: Exclude<RunTimingStatus, "running"> = "completed",
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const finished = await this.runArtifacts.finishPhase(runId, { id: timing.id }, { status, metadata });
    if (!finished) return;
    await this.writeRunEvent(runId, {
      type: "phase_finished",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: finished.label ?? finished.phase,
      timestamp: finished.finishedAt,
      payload: { timing: finished }
    });
  }

  private async finishOpenRunPhase(
    runId: string | null | undefined,
    issue: Issue,
    phase: RunTimingPhase,
    status: Exclude<RunTimingStatus, "running">,
    finishedAt: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    if (!runId) return false;
    try {
      const finished = await this.runArtifacts.finishOpenPhases(runId, { phase }, { status, finishedAt, metadata });
      if (finished.length === 0) return false;
      for (const timing of finished) {
        await this.writeRunEvent(runId, {
          type: "phase_finished", issueId: issue.id, issueIdentifier: issue.identifier, message: timing.label ?? timing.phase, timestamp: timing.finishedAt ?? finishedAt, payload: { timing }
        });
      }
      if (this.running.get(issue.id)?.runId !== runId) await this.runArtifacts.refreshArtifactHashes(runId, ["events.jsonl"]);
      return true;
    } catch (error) {
      await this.writePhaseTimingPersistenceWarning(issue, phase, runId, error);
      return false;
    }
  }

  private async writePhaseTimingEvent(issue: Issue, input: PhaseTimingEventInput): Promise<void> {
    const startedAt = input.startedAt ?? new Date().toISOString();
    const resolvedInput = { ...input, startedAt };
    const timing = phaseTimingLogPayload(resolvedInput);
    await this.logger.write({
      type: "phase_timing",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: input.label ?? input.phase,
      timestamp: input.status === "waiting" ? startedAt : input.finishedAt ?? startedAt,
      payload: { timing }
    });
    const runId = input.runId === null ? null : await this.phaseTimingRunId(issue, input.runId);
    if (!runId) return;
    await persistPhaseTimingToRun(this.runArtifacts, runId, issue, resolvedInput, { activeRunId: this.running.get(issue.id)?.runId }).catch((error: Error) =>
      this.writePhaseTimingPersistenceWarning(issue, input.phase, runId, error)
    );
  }

  private async writePhaseTimingPersistenceWarning(issue: Issue, phase: RunTimingPhase, runId: string, error: unknown): Promise<void> {
    await this.logger
      .write({
        type: "phase_timing_persistence_warning",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: error instanceof Error ? error.message : String(error),
        payload: { phase, runId }
      })
      .catch(() => undefined);
  }

  private async phaseTimingRunId(issue: Issue, explicitRunId?: string | null): Promise<string | null> {
    if (explicitRunId) return explicitRunId;
    const runningRunId = this.running.get(issue.id)?.runId;
    if (runningRunId) return runningRunId;
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(issue.identifier).catch(() => null);
    return state?.activeRunId ?? state?.lastRunId ?? null;
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
      freshnessMessage,
      preflightStatus: this.preflight?.status,
      preflightMessage: this.preflight?.message ?? null,
      repoEnvPath: this.preflight?.repoEnvPath ?? this.repoEnv?.path ?? null,
      repoEnvStatus: this.preflight?.repoEnvStatus ?? this.repoEnv?.status,
      credentialPreflight: this.preflight ?? undefined
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
    if (this.preflight && !preflightAllowsDispatch(this.preflight) && this.preflightWarningMarker !== this.preflight.message) {
      this.preflightWarningMarker = this.preflight.message;
      await this.logger.write({
        type: "daemon_preflight_warning",
        message: this.preflight.message,
        payload: this.preflight
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
        await this.finishRetryBackoff(runtimeRetryToMemory(retry), retry.issue, "canceled", "issue no longer exists in tracker");
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
    if (isSupervisorContinuationPaused(state)) {
      if (runId) await this.runArtifacts.markRunCanceled(runId, `${reason}; supervisor continuation is active`).catch(() => undefined);
      await this.recordIssueState(issue, {
        phase: "human-required",
        activeRunId: undefined,
        nextRetryAt: undefined,
        retryAttempt: undefined,
        stopReason: `${reason}; supervisor continuation is active`,
        lifecycleStatus: state?.lifecycleStatus
      });
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      messages.push(`cleared stale running run for ${issue.identifier}: supervisor continuation is active`);
      return { stale: true, terminal: false, retryRebuilt: false, messages };
    }
    if (state && isLocallySettledIssueState(state)) {
      if (runId) await this.runArtifacts.markRunCanceled(runId, `${reason}; local issue state is ${state.phase}`).catch(() => undefined);
      await this.recordIssueState(issue, {
        activeRunId: undefined,
        nextRetryAt: undefined,
        retryAttempt: undefined,
        stopReason: reason
      });
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      if (state.reviewStatus === "human_required" || state.phase === "human-required") {
        await this.moveIssue(issue, this.config.tracker.reviewState);
      }
      messages.push(`cleared stale running run for ${issue.identifier}: local issue state is already ${state.phase}`);
      return { stale: true, terminal: state.phase === "completed" && state.reviewStatus !== "human_required", retryRebuilt: false, messages };
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
    let state = await new IssueStateStore(resolve(this.options.repoRoot)).read(latest.identifier);
    const linearComments = await this.fetchDispatchGuardrailIssueComments(latest).catch(async (error: Error) => {
      await this.recordCommentReadDispatchStop(latest, error);
      return "failed" as const;
    });
    if (linearComments === "failed") return null;
    state = await this.ingestHumanDecisions(latest, state, linearComments ?? undefined, { authoritativeCommentSet: Boolean(linearComments) });
    const recentLinearComments = linearComments ? latestIssueComments(linearComments, RECENT_LINEAR_COMMENT_LIMIT) : linearComments;
    const scopeReport = await logPreDispatchScopeReport({ repoRoot: resolve(this.options.repoRoot), issue: latest, state, runtime: await this.runtimeState.read(), workspaceRoot: this.config.workspace.root, linearComments: recentLinearComments, logger: this.logger });
    if (await this.classifyAlreadyMergedIssue(latest, state, "dispatch skipped because recorded PR is already merged")) {
      return null;
    }
    if (isSupervisorContinuationPaused(state)) {
      await this.recordIssueState(latest, {
        phase: "human-required",
        activeRunId: undefined,
        nextRetryAt: undefined,
        retryAttempt: undefined,
        stopReason: "supervisor continuation or external fix is active",
        lifecycleStatus: state?.lifecycleStatus
      });
      await this.runtimeState.clearIssue(latest.id);
      this.retries.delete(latest.id);
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: latest.id,
        issueIdentifier: latest.identifier,
        message: "supervisor continuation or external fix is active"
      });
      return null;
    }
    if (await this.dispatchGuardrail(latest, state, scopeReport)) {
      return null;
    }
    return latest;
  }

  private async dispatchGuardrail(issue: Issue, state: IssueState | null, scopeReport: PreDispatchScopeReport | null): Promise<boolean> {
    const decision = latestAuthoritativeDecision(state);
    const allowImplementationContinuation = allowsImplementationContinuation(state, decision);

    const mergeTarget = mergeTargetPullRequest(state);
    if (state?.reviewStatus === "approved" && mergeTarget?.url && !allowImplementationContinuation) {
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      const repoRoot = resolve(this.options.repoRoot);
      const targetValid = await this.validateDispatchPullRequestTarget(issue, mergeTarget.url);
      if (!targetValid) return true;
      const github = new GitHubClient(this.config.github.command);
      const pr = await github.getPullRequest(mergeTarget.url, repoRoot).catch(async (error: Error) => {
        await this.logger.write({
          type: "dispatch_skipped",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: `approved PR exists but GitHub status could not be read: ${error.message}`
        });
        return null;
      });
      if (pr?.merged) {
        await this.classifyAlreadyMergedIssue(issue, state, "dispatch skipped because approved PR is already merged");
        return true;
      }
      const readiness = pr ? evaluateMergeReadiness(pr, this.config.github.requireChecks) : null;
      const message = readiness?.ready
        ? "approved PR is merge-ready; moved issue to Merging instead of redispatching implementation"
        : `approved PR awaits merge readiness${readiness ? `: ${readiness.reason}` : ""}`;
      await this.recordIssueState(issue, {
        phase: readiness?.ready ? "merge" : state.phase,
        mergeTargetUrl: mergeTarget.url,
        mergeTargetRole: mergeTarget.role ?? "primary",
        stopReason: message,
        nextRetryAt: undefined,
        retryAttempt: undefined
      });
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message,
        payload: { prUrl: mergeTarget.url, readiness }
      });
      if (readiness?.ready) await this.moveIssue(issue, this.config.tracker.mergeState);
      return true;
    }

    if (state && !allowImplementationContinuation && isLocallyCompletedState(state)) {
      const message = completedDispatchStopReason(state);
      await this.recordDispatchGuardrailStop(issue, message, {
        phase: "completed",
        stopReason: message,
        lastError: undefined,
        errorCategory: undefined
      });
      await this.moveIssue(issue, this.config.tracker.reviewState);
      return true;
    }

    if (state && !allowImplementationContinuation && (state.reviewStatus === "human_required" || state.phase === "human-required")) {
      const message = "human-required issue needs a trusted structured decision before redispatch";
      await this.recordDispatchGuardrailStop(issue, message, {
        phase: "human-required",
        reviewStatus: "human_required",
        stopReason: message
      });
      await this.moveIssue(issue, this.config.tracker.needsInputState);
      return true;
    }

    const recovery = await this.dispatchRecoveryDiagnostics(issue, state, scopeReport);
    if (recovery?.recoverable && (state ? isRecoverablePartialWorkState(state) : true)) {
      const message = `recoverable partial work found: ${recovery.reasons.join("; ")}`;
      await this.recordIssueState(issue, {
        phase: "human-required",
        reviewStatus: "human_required",
        lifecycleStatus: "implementation_failure",
        lastError: message,
        errorCategory: "workspace",
        stopReason: message,
        nextRetryAt: undefined,
        retryAttempt: undefined
      });
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      await this.markLinearRecoveryNeeded(issue, recovery);
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message,
        payload: recovery
      });
      return true;
    }

    if (!allowImplementationContinuation && scopeReport?.dispatchAdvice.shouldBlock) {
      const message = scopeReport.dispatchAdvice.reason ?? "pre-dispatch scope guardrail blocked implementation dispatch";
      if (scopeReport.likelyLarge) {
        await this.markLinearPlanningRecommended(issue, scopeReport);
      } else {
        await this.recordDispatchGuardrailStop(issue, message, {
          phase: "needs-input",
          stopReason: message
        });
      }
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message,
        payload: scopeReport.dispatchAdvice
      });
      return true;
    }

    return false;
  }

  private async dispatchRecoveryDiagnostics(issue: Issue, state: IssueState | null, scopeReport: PreDispatchScopeReport | null): Promise<WorkspaceRecoveryDiagnostics | null> {
    if (state) return inspectWorkspaceRecovery(resolve(this.options.repoRoot), state).catch(() => null);
    const workspacePath = scopeReport?.evidence.workspace.path;
    if (!workspacePath) return null;
    return inspectWorkspaceRecovery(resolve(this.options.repoRoot), {
      issueIdentifier: issue.identifier,
      workspacePath
    }).catch(() => null);
  }

  private async recordDispatchGuardrailStop(issue: Issue, message: string, patch: Partial<IssueState>): Promise<IssueState> {
    const state = await this.recordIssueState(issue, {
      activeRunId: undefined,
      nextRetryAt: undefined,
      retryAttempt: undefined,
      ...patch,
      stopReason: patch.stopReason ?? message
    });
    await this.runtimeState.clearIssue(issue.id);
    this.retries.delete(issue.id);
    await this.logger.write({
      type: "dispatch_skipped",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message
    });
    return state;
  }

  private async recordCommentReadDispatchStop(issue: Issue, error: Error): Promise<IssueState> {
    const safeError = safeGuardrailErrorMessage(error);
    const message = `could not read latest Linear comments before dispatch guardrails: ${safeError}`;
    return this.recordDispatchGuardrailStop(issue, message, {
      phase: "needs-input", lifecycleStatus: undefined, lastError: message, errorCategory: "prompt", stopReason: message
    });
  }

  private async validateDispatchPullRequestTarget(issue: Issue, prUrl: string): Promise<boolean> {
    try {
      await assertPullRequestUrlMatchesRepo(resolve(this.options.repoRoot), prUrl);
      return true;
    } catch (error) {
      const message = safeGuardrailErrorMessage(error);
      await this.recordDispatchGuardrailStop(issue, message, {
        phase: "human-required",
        reviewStatus: "human_required",
        lastError: message,
        errorCategory: "prompt",
        stopReason: message
      });
      await this.moveIssue(issue, this.config.tracker.reviewState);
      return false;
    }
  }

  private async markLinearPlanningRecommended(issue: Issue, report: PreDispatchScopeReport): Promise<void> {
    const message = report.dispatchAdvice.reason ?? "likely-large scope needs planning or decomposition before implementation dispatch";
    await this.recordDispatchGuardrailStop(issue, message, {
      phase: "needs-input",
      lifecycleStatus: "planning_required",
      lastError: message,
      errorCategory: "prompt",
      stopReason: message
    });
    await this.commentIssue(
      issue,
      [
        "### AgentOS planning recommended",
        "",
        "AgentOS refused to start a fresh implementation turn because the pre-dispatch scope report classified this issue as likely large.",
        "",
        `- Scope: ${report.scopeSize}`,
        report.scopeReasons.length ? `- Scope reasons: ${report.scopeReasons.join("; ")}` : null,
        `- Next safe action: ${report.dispatchAdvice.nextSafeAction}`
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      "planning_recommended"
    );
    await this.moveIssue(issue, this.config.tracker.needsInputState);
    await this.writePhaseTimingEvent(issue, {
      phase: "needs-input",
      status: "waiting",
      label: "planning/decomposition pause started",
      metadata: {
        needsInputState: this.config.tracker.needsInputState,
        reason: message,
        scopeSize: report.scopeSize,
        likelyLarge: report.likelyLarge
      }
    });
  }

  private async preTurnCheck(issue: Issue): Promise<string | null> {
    const trackerStop = await trackerDispatchStop(this.config, this.tracker, issue);
    if (trackerStop) return trackerStop;
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(issue.identifier);
    if (await this.hasAlreadyMergedPullRequest(state)) return "pull_request_already_merged";
    if (isSupervisorContinuationPaused(state)) return "supervisor_continuation_active";
    return null;
  }

  private async classifyTerminalIssue(issue: Issue, reason: string): Promise<void> {
    const phase: IssueState["phase"] = issue.state.toLowerCase() === this.config.github.doneState.toLowerCase() ? "completed" : "canceled";
    const terminalAt = new Date().toISOString();
    const terminalTimingStatus = phase === "completed" ? "completed" : "canceled";
    const storedState = await new IssueStateStore(resolve(this.options.repoRoot)).read(issue.identifier).catch(() => null);
    const retry = await readRuntimeRetryForIssue(this.runtimeState, issue);
    if (retry) await this.finishRetryBackoff(retry, issue, terminalTimingStatus, reason, terminalAt);
    for (const wait of terminalWaitPhaseFinishes(issue, storedState, reason)) await this.finishOpenRunPhase(wait.runId, issue, wait.phase, terminalTimingStatus, terminalAt, wait.metadata);
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    const workspacePath = join(this.config.workspace.root, issue.identifier.replace(/[^A-Za-z0-9._-]/g, "_"));
    const missingWorkspace = !(await exists(resolve(this.options.repoRoot, workspacePath)));
    const missingWorkspaceWarning = terminalWorkspaceWarning(issue, storedState, missingWorkspace);
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
      lifecycleStatus: missingWorkspaceWarning ? "terminal_missing_workspace" : "terminal_linear",
      terminalState: issue.state,
      terminalReason: reason,
      terminalAt,
      reviewStatus: undefined,
      lastError: undefined,
      errorCategory: undefined,
      activeRunId: undefined,
      nextRetryAt: undefined,
      retryAttempt: undefined,
      mergeCleanupWarnings: undefined,
      ...terminalHeadPatch(storedState, null, terminalAt),
      stopReason: reason,
      ...(missingWorkspaceWarning ? { workspaceMissingAt: terminalAt } : { workspaceMissingAt: undefined })
    });
    await this.runtimeState.clearIssue(issue.id);
    this.retries.delete(issue.id);
    this.completedMarkers.set(issue.id, completionMarker(issue));
    await this.logger.write({
      type: "issue_terminal_reconciled",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { state: issue.state, phase, missingWorkspace, terminalWorkspaceWarning: missingWorkspaceWarning }
    });
  }
  private async classifyAlreadyMergedIssue(issue: Issue, state: IssueState | null, reason: string): Promise<boolean> {
    const pr = await this.alreadyMergedPullRequestStatus(state);
    if (!pr) return false;
    const terminalAt = new Date().toISOString();
    const retry = await readRuntimeRetryForIssue(this.runtimeState, issue);
    if (retry) await this.finishRetryBackoff(retry, issue, "completed", reason, terminalAt);
    for (const wait of terminalWaitPhaseFinishes({ ...issue, state: this.config.github.doneState }, state, reason)) await this.finishOpenRunPhase(wait.runId, issue, wait.phase, "completed", terminalAt, wait.metadata);
    const workspaceManager = new WorkspaceManager(this.config, resolve(this.options.repoRoot));
    await workspaceManager.remove(issue.identifier).catch((error: Error) =>
      this.logger.write({
        type: "startup_recovery_warning",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `already-merged workspace cleanup failed: ${error.message}`
      })
    );
    await this.recordIssueState(issue, alreadyMergedIssuePatch(state, pr, terminalAt, reason));
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
      payload: { prUrl: pr.url }
    });
    return true;
  }

  private async hasAlreadyMergedPullRequest(state: IssueState | null): Promise<boolean> {
    return Boolean(await this.alreadyMergedPullRequestStatus(state));
  }

  private async alreadyMergedPullRequestStatus(state: IssueState | null): Promise<PullRequestStatus | null> {
    const urls = uniqueStrings([mergeTargetPullRequest(state)?.url].filter((url): url is string => Boolean(url)));
    if (urls.length === 0) return null;
    const github = new GitHubClient(this.config.github.command);
    const repoRoot = resolve(this.options.repoRoot);
    for (const url of urls) {
      const targetMatchesRepo = await assertPullRequestUrlMatchesRepo(repoRoot, url).then(
        () => true,
        async (error: unknown) => {
          const message = safeGuardrailErrorMessage(error);
          await this.logger.write({
            type: "github_status_warning",
            message: `skipping off-repository PR merge-state read for ${url}: ${message}`
          });
          return false;
        }
      );
      if (!targetMatchesRepo) continue;
      const status = await github.getPullRequest(url, repoRoot).catch(async (error: Error) => {
        const message = safeGuardrailErrorMessage(error);
        await this.logger.write({
          type: "github_status_warning",
          message: `could not read PR merge state for ${url}: ${message}`
        });
        return null;
      });
      if (status?.merged) return status;
    }
    return null;
  }

  private async dispatch(issue: Issue, attempt: number | null): Promise<boolean> {
    const dispatchStop = await trackerDispatchStop(this.config, this.tracker, issue);
    if (dispatchStop && isConfiguredReviewDispatchStop(this.config, dispatchStop)) {
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: dispatchStop
      });
      return false;
    }
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
    return true;
  }

  private async runIssue(issue: Issue, attempt: number | null, abortController: AbortController): Promise<void> {
    const startStop = await trackerDispatchStop(this.config, this.tracker, issue);
    if (startStop && isConfiguredReviewDispatchStop(this.config, startStop)) {
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: startStop
      });
      return;
    }
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
      const linearStarted = await this.markLinearStarted(issue, workspace, attempt);
      if (!linearStarted) {
        const stopReason = `issue_no_longer_dispatchable:${this.config.tracker.reviewState ?? "review"}`;
        const result: AgentRunResult = { status: "canceled", error: stopReason };
        await this.writeRunEvent(runId, {
          type: "run_canceled",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: stopReason,
          payload: result
        });
        await this.handleTerminalStoppedRun(issue, stopReason, runId);
        await this.runArtifacts.completeRun(runId, result);
        return;
      }
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
        let validation: Awaited<ReturnType<typeof verifyValidationEvidence>> | null = null;
        if (handoff) {
          const validationVerificationStartedAt = new Date().toISOString();
          try {
            validation = await verifyValidationEvidence({ issue, handoff, workspacePath: workspace.path, runId });
            await this.writePhaseTimingEvent(issue, {
              phase: "validation",
              status: validation.state.status === "passed" ? "completed" : "failed",
              runId,
              ...validationTimingFromEvidence(validation, validationVerificationStartedAt, new Date().toISOString())
            });
          } catch (error) {
            await this.writePhaseTimingEvent(issue, {
              phase: "validation",
              status: "failed",
              runId,
              startedAt: validationVerificationStartedAt,
              finishedAt: new Date().toISOString(),
              label: "validation evidence verification",
              metadata: {
                timingSource: "evidence-verification",
                evidencePath: `.agent-os/validation/${issue.identifier}.json`,
                error: error instanceof Error ? error.message : String(error)
              }
            });
            throw error;
          }
        }
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
        const reviewedState = await this.reviewIfNeeded(issue, workspace, persistedState, attempt, abortController.signal, runId);
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
      const implementationTiming = await this.startRunPhase(runId, issue, "implementation", `implementation turn ${turnNumber}`, { turnNumber, maxTurns: this.config.agent.maxTurns });
      try {
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
      } catch (error) {
        await this.finishRunPhase(runId, issue, implementationTiming, "failed", { turnNumber, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      await this.finishRunPhase(runId, issue, implementationTiming, timingStatusForRunResult(result), { turnNumber, resultStatus: result.status });
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
    const stateStore = new IssueStateStore(resolve(this.options.repoRoot));
    const state = await stateStore.read(issue.identifier);
    const existingAudit = existingImplementationAuditContext(state);
    const linearReentry = await this.linearReentryContext(issue, state);
    const latestState = (await stateStore.read(issue.identifier)) ?? state;
    const continuation = turnNumber > 1
      ? [
          "",
          "## AgentOS Continuation",
          "",
          `This is turn ${turnNumber} of ${this.config.agent.maxTurns}. The previous turn completed without writing the required handoff file.`,
          "Continue the same issue in this workspace and write the required `.agent-os/handoff-<issue>.md` before finishing."
        ].join("\n")
      : "";
    const existingPr = primaryPullRequestUrl(latestState);
    let feedback: string | null = null;
    let pullRequests = existingPr ? pullRequestContextEntriesForUrls(latestState, [existingPr]) : [];
    if (existingPr && issue.state.toLowerCase() === "todo") {
      const githubContext = await readGitHubReviewContext(pullRequestRefsForUrls(latestState, [existingPr]), { githubCommand: this.config.github.command, repoRoot: this.options.repoRoot }).catch(() => null);
      if (githubContext) {
        pullRequests = githubContext.entries;
        feedback = githubContext.feedback || null;
      } else {
        feedback = await this.githubFeedbackSummary(existingPr).catch((error: Error) => `Could not fetch GitHub feedback: ${error.message}`);
      }
    }
    const contextPack = buildTargetedContextPack({ kind: "implementation-reentry", issue, state: latestState, pullRequests, validation: latestState?.validation, findings: latestState?.findings, feedback, runId });
    if (!existingPr || issue.state.toLowerCase() !== "todo") return `${base}${runContext}\n\n${contextPack}${existingAudit}${linearReentry}${continuation}`;

    return [
      base,
      runContext,
      "",
      contextPack,
      existingAudit,
      linearReentry,
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

  private async linearReentryContext(issue: Issue, currentState: IssueState | null): Promise<string> {
    const comments = await this.fetchRecentIssueComments(issue, 10);
    if (!comments) return "";
    const state = await this.ingestHumanDecisions(issue, currentState, comments);
    const decisions = mergeHumanDecisions([...(state?.humanDecisions ?? []), ...(state?.lastHumanDecision ? [state.lastHumanDecision] : [])], []) ?? [];
    if (comments.length === 0 && decisions.length === 0) return "";
    const latestAuthoritativeDecision = latestAuthoritativeHumanDecision(decisions);
    const latestContextOnlyDecision = latestHumanDecision(decisions.filter((decision) => !isAuthoritativeHumanDecision(decision)));
    return [
      "",
      "## Linear Human Decision Re-entry",
      "",
      "Recent Linear comments are re-entry input. Structured human decisions are authoritative only when written by a configured trusted actor or the issue assignee, and then take precedence over stale handoff state.",
      latestAuthoritativeDecision ? formatHumanDecision(latestAuthoritativeDecision) : "Authoritative structured human decision: none recorded.",
      latestContextOnlyDecision ? formatHumanDecision(latestContextOnlyDecision, "Context-only structured human decision") : null,
      state?.reviewStatus ? `Review status from issue state: ${state.reviewStatus}${state.reviewIteration ? ` iteration ${state.reviewIteration}` : ""}` : null,
      state?.reviewTargetUrls?.length ? `Review targets: ${state.reviewTargetUrls.join(", ")}` : null,
      "",
      "Recent Linear comments:",
      ...latestIssueComments(comments, 5).map((comment) => formatLinearComment(comment.id, comment.author, comment.updatedAt ?? comment.createdAt, comment.body))
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  private async fetchRecentIssueComments(issue: Issue, limit: number): Promise<IssueComment[] | null> {
    if (!this.tracker.fetchIssueComments) return null;
    try {
      const comments = await this.tracker.fetchIssueComments(issue.identifier, limit);
      return latestIssueComments(comments, limit);
    } catch (error) {
      await this.logger.write({ type: "linear_comment_read_failed", issueId: issue.id, issueIdentifier: issue.identifier, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async fetchDispatchGuardrailIssueComments(issue: Issue): Promise<IssueComment[] | null> {
    if (!this.tracker.fetchIssueComments) return null;
    try {
      const comments = await this.tracker.fetchIssueComments(issue.identifier, GUARDRAIL_LINEAR_COMMENT_LIMIT);
      return latestIssueComments(comments, GUARDRAIL_LINEAR_COMMENT_LIMIT);
    } catch (error) {
      await this.logger.write({ type: "linear_comment_read_failed", issueId: issue.id, issueIdentifier: issue.identifier, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async ingestHumanDecisions(issue: Issue, currentState: IssueState | null, comments?: IssueComment[], options: { authoritativeCommentSet?: boolean } = {}): Promise<IssueState | null> {
    const fetchedComments = comments ?? (await this.fetchRecentIssueComments(issue, RECENT_LINEAR_COMMENT_LIMIT));
    if (!fetchedComments) return currentState;
    const decisions = extractHumanDecisionsFromComments(fetchedComments, {
      trustedActors: this.config.lifecycle.trustedDecisionActors,
      issueAssignee: issue.assignee,
      issueAssigneeId: issue.assigneeId,
      issueAssigneeEmail: issue.assigneeEmail
    });
    const previousDecisions = mergeHumanDecisions([...(currentState?.humanDecisions ?? []), ...(currentState?.lastHumanDecision ? [currentState.lastHumanDecision] : [])], []) ?? [];
    const mergedDecisions = reconcileHumanDecisionsForFetchedComments(previousDecisions, decisions, fetchedComments, options);
    const newDecisions = mergedDecisions.filter((decision) => !hasHumanDecision(previousDecisions, decision));
    const removedDecisions = previousDecisions.filter((decision) => !hasHumanDecision(mergedDecisions, decision));
    const latestAuthoritativeDecision = latestAuthoritativeHumanDecision(mergedDecisions);
    const latestDecision = latestAuthoritativeDecision ?? latestHumanDecision(mergedDecisions);
    const nextLifecycleStatus = latestAuthoritativeDecision ? lifecycleStatusForHumanDecision(latestAuthoritativeDecision) : undefined;
    const currentLastDecision = currentState?.lastHumanDecision ?? null;
    const lastDecisionChanged = Boolean(currentLastDecision) !== Boolean(latestDecision) || Boolean(currentLastDecision && latestDecision && !hasHumanDecision([currentLastDecision], latestDecision));
    const lifecycleStatusChanged = currentState?.lifecycleStatus !== nextLifecycleStatus;
    if (newDecisions.length === 0 && removedDecisions.length === 0 && !lastDecisionChanged && !lifecycleStatusChanged) return currentState;
    const previousLastRunId = currentState?.lastRunId ?? null;
    const state = await this.recordIssueState(issue, {
      humanDecisions: mergedDecisions,
      lastHumanDecision: latestDecision,
      lastHumanFeedbackAt: latestDecision?.decidedAt ?? null,
      lifecycleStatus: nextLifecycleStatus
    }, { replaceHumanDecisions: true });
    await this.logger.write({
      type: "human_decision_recorded",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: latestDecision?.type ?? "unknown",
      payload: { decisions: mergedDecisions, newDecisions, removedDecisions }
    });
    if (latestDecision) {
      await this.writePhaseTimingEvent(issue, {
        phase: currentState?.phase === "needs-input" || currentState?.lifecycleStatus === "implementation_failure" ? "needs-input" : "human-wait",
        status: "completed",
        runId: previousLastRunId,
        startedAt: timingStartNoLaterThan(currentState?.updatedAt, latestDecision.decidedAt),
        finishedAt: latestDecision.decidedAt,
        label: "human decision recorded",
        metadata: {
          decisionType: latestDecision.type,
          actor: latestDecision.actor,
          source: latestDecision.source
        }
      });
    }
    return state;
  }
  private async githubFeedbackSummary(prUrl: string): Promise<string> {
    const github = new GitHubClient(this.config.github.command);
    const status = await github.getPullRequest(prUrl, resolve(this.options.repoRoot));
    const threads = await github.getPullRequestReviewThreads(prUrl, resolve(this.options.repoRoot)).catch(() => []);
    return summarizeFeedback(status, threads);
  }

  private async dispatchDueRetries(maxDispatches = Number.POSITIVE_INFINITY): Promise<number> {
    if (maxDispatches <= 0) return 0;
    const due = [...this.retries.values()]
      .filter((retry) => retry.dueAtMs <= Date.now())
      .sort((a, b) => a.dueAtMs - b.dueAtMs);
    if (due.length === 0) return 0;

    const states = await this.tracker.fetchIssueStates(due.map((retry) => retry.issueId)).catch(() => null);
    let dispatched = 0;
    for (const retry of due) {
      if (dispatched >= maxDispatches) break;
      if (this.running.size >= this.config.agent.maxConcurrentAgents) break;
      if (this.running.has(retry.issueId) || this.claimed.has(retry.issueId)) continue;
      const current = states?.get(retry.issueId);
      if (current === null) {
        this.retries.delete(retry.issueId);
        await this.finishRetryBackoff(retry, retry.issue, "canceled", "issue no longer exists in tracker");
        continue;
      }
      const issue = current ?? retry.issue;
      if (isStateIn(issue.state, this.config.tracker.terminalStates)) {
        await this.finishRetryBackoff(retry, issue, "canceled", `Linear state is terminal: ${issue.state}`);
        await this.classifyTerminalIssue(issue, "retry skipped because Linear state is terminal");
        this.retries.delete(retry.issueId);
        await this.runtimeState.clearIssue(retry.issueId);
        continue;
      }
      if (!this.hasSlot(issue.state)) continue;
      const prepared = await this.prepareForDispatch(issue);
      if (!prepared) {
        if (!this.retries.has(retry.issueId)) await this.finishRetryBackoff(retry, issue, "canceled", "retry skipped before dispatch");
        continue;
      }
      const didDispatch = await this.dispatch(prepared, retry.attempt);
      if (didDispatch) {
        await this.finishRetryBackoff(retry, prepared, "completed", "retry dispatched");
        dispatched += 1;
      } else {
        await this.finishRetryBackoff(retry, prepared, "canceled", "retry skipped before dispatch");
      }
    }
    return dispatched;
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
    const stale: RunningEntry[] = [];
    for (const [id, entry] of this.running.entries()) {
      const elapsed = Date.now() - (entry.lastCodexEventAt ?? entry.startedAt);
      if (this.config.codex.stallTimeoutMs > 0 && elapsed > this.config.codex.stallTimeoutMs) {
        entry.abortController.abort();
        stale.push(entry);
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
        await this.writePhaseTimingEvent(issue, {
          phase: "stall-cancel",
          status: "canceled",
          startedAt: new Date(running.lastCodexEventAt ?? running.startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          label: "terminal-state cancel",
          metadata: { state: issue.state }
        });
        await workspaceManager.remove(issue.identifier);
      } else if (!isStateIn(issue.state, runningAllowedStates(this.config))) {
        running.abortController.abort();
        await this.writePhaseTimingEvent(issue, {
          phase: "stall-cancel",
          status: "canceled",
          startedAt: new Date(running.lastCodexEventAt ?? running.startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          label: "non-dispatchable-state cancel",
          metadata: { state: issue.state }
        });
      }
    }
    for (const entry of stale) {
      await this.writePhaseTimingEvent(entry.issue, {
        phase: "stall-cancel",
        status: "stalled",
        startedAt: new Date(entry.lastCodexEventAt ?? entry.startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        label: "stall timeout exceeded",
        metadata: { stallTimeoutMs: this.config.codex.stallTimeoutMs }
      });
      await this.logger.write({ type: "run_stalled", issueId: entry.issue.id, issueIdentifier: entry.issue.identifier, message: "stall timeout exceeded" });
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

  private async reviewIfNeeded(issue: Issue, workspace: Workspace, state: IssueState | null, attempt: number | null, signal?: AbortSignal, runId?: string): Promise<IssueState | null> {
    if (!this.config.review.enabled) return state;
    const reviewTargetMode = this.config.review.targetMode ?? "merge-eligible";
    if (!state || state.outcome === "already_satisfied") return state;
    let latestState: IssueState | null = state;
    const initialReviewTargets = reviewTargetPullRequests(state, reviewTargetMode);
    if (initialReviewTargets.length === 0 && pullRequestUrls(state).length === 0) return latestState;
    const reviewTiming = runId ? await this.startRunPhase(runId, issue, "automated-review", "automated review", { reviewTargetMode }) : null;
    const finishReviewTiming = async (unwoundByError: boolean): Promise<void> => {
      if (!runId || !reviewTiming) return;
      const reviewStatus = latestState?.reviewStatus;
      await this.finishRunPhase(runId, issue, reviewTiming, reviewStatus === "approved" || (reviewStatus === "pending" && !unwoundByError) ? "completed" : "failed", {
        reviewStatus,
        reviewIteration: latestState?.reviewIteration,
        reviewTargetMode,
        ...(unwoundByError ? { reviewExit: "error" } : {})
      });
    };
    let reviewUnwoundByError = false;
    try {
      if (initialReviewTargets.length === 0) {
        latestState = await this.recordReviewTargetSelectionFailure(issue, state, reviewTargetMode);
        return latestState;
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
        `- Reviewer concurrency: ${this.config.review.parallelReviewers ? `up to ${this.config.review.maxConcurrentReviewers}` : "sequential"}`,
        `- Max iterations: ${this.config.review.maxIterations}`
      ].join("\n")
    );

    const repoRoot = resolve(this.options.repoRoot);
    let previousFindings = state.findings ?? [];
    let reviewRunnerFailures: ReviewRunnerFailure[] = [];
    latestState = await this.recordIssueState(issue, {
      phase: "review",
      reviewStatus: "pending",
      reviewIteration: state.reviewIteration ?? 0,
      reviewTargetMode,
      reviewTargetUrls: initialReviewTargetUrls,
      reviewRunnerFailures: []
    });
    for (let iteration = (state.reviewIteration ?? 0) + 1; iteration <= this.config.review.maxIterations; iteration += 1) {
      const reviewTargets = reviewTargetPullRequests(latestState, reviewTargetMode);
      if (reviewTargets.length === 0) {
        latestState = pullRequestUrls(latestState).length > 0 ? await this.recordReviewTargetSelectionFailure(issue, latestState, reviewTargetMode) : latestState;
        return latestState;
      }
      const reviewPr = reviewTargets[0].url;
      const reviewTargetUrls = reviewTargets.map((target) => target.url);
      const reviewTargetList = formatPullRequestTargets(reviewTargets);
      await ensureReviewIterationDir(workspace.path, issue.identifier, iteration);
      const githubContext = await readGitHubReviewContext(reviewTargets, { githubCommand: this.config.github.command, repoRoot: this.options.repoRoot }).catch(async (error: Error) => {
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
      const reviewerConcurrency = reviewerConcurrencyFor(this.config, reviewers.length);
      const parallelReviewers = reviewerConcurrency > 1;

      await this.logger.write({
        type: "review_started",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}`,
        payload: { prUrls: reviewTargetUrls, reviewers, reviewerConcurrency, mode: parallelReviewers ? "parallel" : "sequential" }
      });

      const reviewerResult = await runReviewerIteration({
        issue,
        iteration,
        reviewers,
        reviewPr,
        reviewTargetUrls,
        githubContext,
        previousFindings,
        latestState,
        workspace,
        repoRoot,
        attempt,
        signal,
        runId,
        config: this.config,
        runner: this.runner,
        logger: this.logger,
        onActivity: (issueId, timestamp) => this.markRunningActivity(issueId, timestamp)
      });
      reviewRunnerFailures = [...reviewRunnerFailures, ...reviewerResult.reviewRunnerFailures];
      const artifacts = reviewerResult.artifacts;
      const terminalReviewerFailure = reviewerResult.terminalReviewerFailure;
      const reviewerStates = reviewerResult.reviewerStates;

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
      const humanRequired =
        Boolean(terminalReviewerFailure) ||
        artifacts.some((entry) => entry.artifact.decision === "human_required") ||
        findings.some((finding) => finding.decision === "human_required");
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
        reviewTargetUrls,
        reviewRunnerFailures
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
        const reason = terminalReviewerFailure
          ? terminalReviewerFailure.classification === "mechanical" && terminalReviewerFailure.exhausted
            ? "a reviewer runner failed to produce a trusted artifact after its retry budget was exhausted"
            : "a reviewer runner failure requires human judgment"
          : humanRequired
            ? "a reviewer requested human judgment"
          : repeated.length > 0
            ? "the same blocking finding repeated after a fix"
            : "maximum review iterations reached";
        latestState = await this.recordIssueState(issue, { phase: "review", reviewStatus: "human_required", findings, reviewRunnerFailures });
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
            "Reviewer runner failures:",
            formatReviewRunnerFailures(reviewRunnerFailures),
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
          payload: { findings: blocking, repeated, prUrls: reviewTargetUrls, reviewRunnerFailures }
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
      const fixTiming = runId ? await this.startRunPhase(runId, issue, "fixer-turn", `fixer turn ${iteration}`, { iteration, blockingFindings: blocking.length }) : null;
      let fixResult: AgentRunResult;
      try {
        const fixContextKind = blocking.some((finding) => finding.reviewer === "checks") ? "ci-repair" : "fixer";
        fixResult = await this.runner.run({
          issue,
          prompt: fixPrompt({
            issue,
            prUrl: reviewPr,
            reviewTargets: reviewTargetUrls,
            iteration,
            findings: blocking,
            handoffPath: join(workspace.path, ".agent-os", `handoff-${issue.identifier}.md`),
            feedbackSummary: githubContext.feedback,
            contextPack: buildTargetedContextPack({ kind: fixContextKind, issue, state: latestState, pullRequests: githubContext.entries, findings: blocking, validation: latestState?.validation, feedback: githubContext.feedback, artifactRefs: [join(workspace.path, ".agent-os", `handoff-${issue.identifier}.md`)], runId, iteration })
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
      } catch (error) {
        if (runId && fixTiming) await this.finishRunPhase(runId, issue, fixTiming, "failed", { iteration, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      if (runId && fixTiming) await this.finishRunPhase(runId, issue, fixTiming, timingStatusForRunResult(fixResult), { iteration, resultStatus: fixResult.status });
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
    } catch (error) {
      reviewUnwoundByError = true;
      throw error;
    } finally {
      await finishReviewTiming(reviewUnwoundByError);
    }
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

  private async shepherdMergeIssue(issue: Issue): Promise<void> {
    const timingStartedAt = new Date().toISOString();
    let timingStatus: RunTimingStatus = "completed";
    let timingLabel = "merge shepherding completed";
    let timingMetadata: Record<string, unknown> = {};
    const stateStore = new IssueStateStore(resolve(this.options.repoRoot));
    const state = await stateStore.read(issue.identifier);
    await this.finishOpenRunPhase(state?.lastRunId, issue, "human-wait", "completed", timingStartNoLaterThan(issue.updated_at, timingStartedAt), { reason: "issue entered merge state" });
    const mergeTarget = mergeTargetPullRequest(state);
    const mergePr = mergeTarget?.url ?? null;
    const mergeEligiblePrs = mergeEligiblePullRequests(state);
    try {
      if (state && !mergePr && isNoPrHandoffApproved(state) && mergeEligiblePrs.length === 0) {
        timingMetadata = { result: "approved no-PR handoff" };
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
        const reason = mergeTargetAmbiguityReason(state) ?? "Merge target selection is ambiguous; select exactly one primary PR before merging.";
        timingStatus = "failed";
        timingLabel = "merge shepherding failed";
        timingMetadata = { reason };
        await this.markMergeFailed(issue, reason, { runId: state.lastRunId });
        return;
      }
      if (!state || !mergePr) {
        const reason = "No pull request metadata was found for this issue.";
        timingStatus = "failed";
        timingLabel = "merge shepherding failed";
        timingMetadata = { reason };
        await this.markMergeFailed(issue, reason, { runId: state?.lastRunId });
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
          const ciWaitFinishedAt = new Date().toISOString();
          await this.finishOpenRunPhase(state.lastRunId, issue, "ci-wait", "completed", ciWaitFinishedAt, { prUrl: mergePr, result: "already merged" });
          const cleanupWarnings = await this.cleanupMergedPullRequest(issue, github, pr);
          timingMetadata = { prUrl: mergePr, result: "already merged", cleanupWarnings };
          await this.recordIssueState(issue, alreadyMergedIssuePatch(state, pr, new Date().toISOString(), "merge shepherd: pull request is already merged", cleanupWarnings));
          await this.runtimeState.clearIssue(issue.id);
          this.retries.delete(issue.id);
          await this.commentIssue(issue, `### AgentOS merge shepherd\n\nPull request is already merged. Treating that as authoritative and completing the issue.\n\n- PR: ${mergePr}${cleanupWarnings.length ? `\n\nCleanup warnings:\n${cleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`);
          await this.moveIssue(issue, this.config.github.doneState);
          return;
        }

        if (this.config.review.enabled && state.reviewStatus !== "approved") {
          if (!this.config.github.allowHumanMergeOverride) {
            const reason = `automated review is not approved (reviewStatus=${state.reviewStatus ?? "missing"})`;
            timingStatus = "failed";
            timingLabel = "merge shepherding failed";
            timingMetadata = { prUrl: mergePr, reason };
            await this.markMergeFailed(issue, reason, { prUrl: mergePr, runId: state.lastRunId });
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
            const reason = "human continuation requires fresh passing validation evidence before merge progression";
            timingStatus = "failed";
            timingLabel = "merge shepherding failed";
            timingMetadata = { prUrl: mergePr, reason };
            await this.markMergeFailed(issue, reason, { prUrl: mergePr, runId: state.lastRunId });
            return;
          }
        }

        const readiness = evaluateMergeReadiness(pr, this.config.github.requireChecks);
        if (!readiness.ready) {
          if (readiness.reason.includes("pending")) {
            timingStatus = "waiting";
            timingLabel = "merge shepherding waiting on CI";
            timingMetadata = { prUrl: mergePr, reason: readiness.reason };
            await this.markMergeWaiting(issue, mergePr, readiness.reason, state.lastRunId);
          } else {
            const ciWaitFinishedAt = new Date().toISOString();
            await this.finishOpenRunPhase(state.lastRunId, issue, "ci-wait", "failed", ciWaitFinishedAt, { prUrl: mergePr, reason: readiness.reason });
            timingStatus = "failed";
            timingLabel = "merge shepherding failed";
            timingMetadata = { prUrl: mergePr, reason: readiness.reason };
            await this.markMergeFailed(issue, readiness.reason, { prUrl: mergePr, runId: state.lastRunId });
          }
          return;
        }

        const ciWaitFinishedAt = new Date().toISOString();
        await this.finishOpenRunPhase(state.lastRunId, issue, "ci-wait", "completed", ciWaitFinishedAt, { prUrl: mergePr, reason: "checks ready" });
        await this.commentIssue(issue, `### AgentOS merge shepherd\n\nChecks are green and the pull request is mergeable. Starting ${this.config.github.mergeMethod} merge.\n\n- PR: ${mergePr}`);
        await github.mergePullRequest(mergePr, this.config.github, repoRoot);
        const cleanupWarnings = await this.cleanupMergedPullRequest(issue, github, pr);
        timingMetadata = { prUrl: mergePr, mergeMethod: this.config.github.mergeMethod, cleanupWarnings };
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
        const reason = error instanceof Error ? error.message : String(error);
        timingStatus = "failed";
        timingLabel = "merge shepherding failed";
        timingMetadata = { prUrl: mergePr, reason };
        await this.markMergeFailed(issue, reason, { prUrl: mergePr, runId: state.lastRunId });
      }
    } finally {
      await this.writePhaseTimingEvent(issue, {
        phase: "merge-shepherding",
        status: timingStatus,
        runId: state?.lastRunId,
        startedAt: timingStartedAt,
        finishedAt: new Date().toISOString(),
        label: timingLabel,
        metadata: timingMetadata
      });
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
      void this.runtimeState.patchActiveRun(issueId, { lastEventAt: timestamp }).catch((error: Error) =>
        this.logger.write({
          type: "runtime_state_warning",
          issueId,
          message: `activity update failed: ${error.message}`
        })
      );
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
    const safeError = summarizeText(error).inline;
    if (isHumanInputStop(error)) {
      this.completedMarkers.set(issue.id, completionMarker(issue));
      await this.writeRunEvent(runId, {
        type: "run_needs_human_input",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: safeError,
        payload: { errorCategory: "human-input" }
      });
      await this.recordIssueState(issue, {
        phase: "needs-input",
        lastError: safeError,
        errorCategory: "human-input",
        stopReason: safeError,
        nextRetryAt: undefined,
        retryAttempt: undefined
      });
      await this.markLinearNeedsInput(issue, workspace, previousAttempt, safeError);
      return;
    }
    const nextAttempt = previousAttempt == null ? 1 : previousAttempt + 1;
    if (nextAttempt > this.config.agent.maxRetryAttempts) {
      await this.recordIssueState(issue, {
        phase: "needs-input",
        lastError: safeError,
        errorCategory: categorizeRunError(error),
        lifecycleStatus: "implementation_failure",
        stopReason: safeError,
        workspacePath: workspace.path,
        workspaceKey: workspace.workspaceKey,
        nextRetryAt: undefined
      });
      await this.markLinearFailed(issue, workspace, previousAttempt, safeError);
      return;
    }
    const retry = await this.scheduleRetry(issue, previousAttempt, safeError, undefined, runId, workspace);
    await this.recordIssueState(issue, {
      lastError: safeError,
      errorCategory: categorizeRunError(error),
      lifecycleStatus: "implementation_failure",
      stopReason: safeError,
      retryAttempt: retry.attempt,
      nextRetryAt: new Date(retry.dueAtMs).toISOString()
    });
    await this.markLinearRetryScheduled(issue, workspace, retry);
  }

  private async scheduleRetry(issue: Issue, previousAttempt: number | null, error: string | null, overrideDelayMs?: number, runId?: string, workspace?: Workspace): Promise<RetryEntry> {
    const attempt = previousAttempt == null ? 1 : previousAttempt + 1;
    const delay = overrideDelayMs ?? Math.min(10_000 * 2 ** Math.max(attempt - 1, 0), this.config.agent.maxRetryBackoffMs);
    const scheduledAt = new Date().toISOString();
    const retry = {
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt,
      dueAtMs: Date.now() + delay,
      scheduledAt,
      error,
      runId
    };
    const dueAt = new Date(retry.dueAtMs).toISOString();
    this.retries.set(issue.id, retry);
    await this.runtimeState.upsertRetry({
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt,
      dueAt,
      error,
      errorCategory: error ? categorizeRunError(error) : undefined,
      scheduledAt,
      runId,
      workspacePath: workspace?.path,
      workspaceKey: workspace?.workspaceKey
    });
    await this.writePhaseTimingEvent(issue, {
      phase: "retry-backoff",
      status: "waiting",
      runId,
      startedAt: scheduledAt,
      label: "retry backoff scheduled",
      metadata: {
        attempt,
        maxAttempts: this.config.agent.maxRetryAttempts,
        delayMs: delay,
        dueAt,
        errorCategory: error ? categorizeRunError(error) : undefined,
        runId
      }
    });
    return retry;
  }

  private async finishRetryBackoff(retry: RetryEntry, issue: Issue, status: Exclude<RunTimingStatus, "running" | "waiting">, reason: string, finishedAt = new Date().toISOString()): Promise<void> {
    await this.finishOpenRunPhase(retry.runId, issue, "retry-backoff", status, finishedAt, retryBackoffFinishMetadata(retry, reason));
  }

  private async markLinearStarted(issue: Issue, workspace: Workspace, attempt: number | null): Promise<boolean> {
    const moveResult = await this.moveIssue(issue, this.config.tracker.runningState);
    if (moveResult === "blocked") return false;
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
    return true;
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
    await this.writePhaseTimingEvent(issue, {
      phase: "human-wait",
      status: "waiting",
      label: "human review wait started",
      metadata: {
        reviewState: this.config.tracker.reviewState,
        reviewStatus: state?.reviewStatus
      }
    });
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
    const recovery = await inspectWorkspaceRecovery(resolve(this.options.repoRoot), {
      issueIdentifier: issue.identifier,
      workspacePath: workspace.path
    }).catch(() => null);
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
        recovery ? "" : null,
        recovery ? formatRecoveryDiagnostics(recovery).join("\n") : null,
        "",
        "Please adjust the issue, repo, or workflow instructions before returning it to an active state."
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      "run_failed"
    );
    await this.moveIssue(issue, this.config.tracker.needsInputState);
    await this.writePhaseTimingEvent(issue, {
      phase: "needs-input",
      status: "waiting",
      label: "needs-input pause started",
      metadata: {
        needsInputState: this.config.tracker.needsInputState,
        reason: "recoverable partial work"
      }
    });
  }

  private async markLinearRecoveryNeeded(issue: Issue, recovery: WorkspaceRecoveryDiagnostics): Promise<void> {
    await this.commentIssue(
      issue,
      [
        "### AgentOS recovery needed",
        "",
        "AgentOS found recoverable partial work and refused to start a fresh implementation turn.",
        "",
        formatRecoveryDiagnostics(recovery).join("\n")
      ].join("\n"),
      "recovery_needed"
    );
    await this.moveIssue(issue, this.config.tracker.needsInputState);
    await this.writePhaseTimingEvent(issue, {
      phase: "needs-input",
      status: "waiting",
      label: "needs-input pause started",
      metadata: {
        needsInputState: this.config.tracker.needsInputState,
        reason: "recoverable partial work",
        dirty: recovery.dirty,
        aheadCount: recovery.aheadCount
      }
    });
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
    await this.writePhaseTimingEvent(issue, {
      phase: "needs-input",
      status: "waiting",
      label: "needs-input pause started",
      metadata: {
        needsInputState: this.config.tracker.needsInputState,
        error
      }
    });
  }

  private async markMergeWaiting(issue: Issue, prUrl: string, reason: string, runId?: string | null): Promise<void> {
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
    await this.writePhaseTimingEvent(issue, {
      phase: "ci-wait",
      status: "waiting",
      runId,
      startedAt: issue.updated_at ?? undefined,
      label: "ci wait started",
      metadata: { prUrl, reason }
    });
  }

  private async markMergeFailed(issue: Issue, reason: string, options: { prUrl?: string | null; runId?: string | null } = {}): Promise<void> {
    const prUrl = options.prUrl ?? undefined;
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
      ].filter((line): line is string => line !== null).join("\n"),
      "merge_failed"
    );
    await this.moveIssue(issue, this.config.tracker.reviewState);
    await this.writePhaseTimingEvent(issue, {
      phase: "human-wait", status: "waiting", runId: options.runId, label: "human review wait restarted",
      metadata: { reviewState: this.config.tracker.reviewState, reason, ...(prUrl ? { prUrl } : {}) }
    });
    await this.logger.write({
      type: "merge_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl }
    });
  }

  private async recordIssueState(issue: Issue, patch: Partial<IssueState>, options: { replaceHumanDecisions?: boolean } = {}): Promise<IssueState> {
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).merge(issue.identifier, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      ...patch
    }, options);
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

  private async moveIssue(issue: Issue, stateName: string | null): Promise<TrackerUpdateResult> {
    if (!stateName || !this.tracker.move || !orchestratorMayMoveIssue(this.config)) return "unsupported";
    if (await reviewStateBlocksTrackerUpdate({ config: this.config, tracker: this.tracker, logger: this.logger, issue, operation: `move to ${stateName}` })) return "blocked";
    try {
      await this.tracker.move(issue.identifier, stateName);
      return "applied";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `move to ${stateName}: ${message}`
      });
      return "failed";
    }
  }

  private async commentIssue(issue: Issue, body: string, key?: string, kind: "bookkeeping" | "substantive" = "bookkeeping"): Promise<void> {
    if (!orchestratorMayComment(this.config, kind)) return;
    if (!this.tracker.comment && !this.tracker.upsertComment) return;
    if (await reviewStateBlocksTrackerUpdate({ config: this.config, tracker: this.tracker, logger: this.logger, issue, operation: "comment" })) return;
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

function isNoPrHandoffApproved(state: IssueState): boolean { return state.phase === "completed" && (state.validation?.finalStatus === "passed" || state.validation?.status === "passed"); }

function isLocallySettledIssueState(state: IssueState): boolean { return state.phase === "completed" || state.phase === "canceled" || state.phase === "human-required" || state.reviewStatus === "human_required"; }

function isLocallyCompletedState(state: IssueState): boolean {
  return state.phase === "completed" || state.outcome === "already_satisfied";
}

function completedDispatchStopReason(state: IssueState): string {
  if (state.outcome === "already_satisfied") return "work is already satisfied by prior AgentOS handoff";
  if (pullRequestUrls(state).length > 0) return "work is already completed locally and has recorded pull request metadata";
  return "work is already completed locally and should not be redispatched";
}

function isSupervisorContinuationPaused(state: IssueState | null): boolean {
  if (!state?.lifecycleStatus) return false;
  if (!["human_continuation", "supervisor_continuation", "externally_fixed"].includes(state.lifecycleStatus)) return false;
  const decision = latestAuthoritativeDecision(state);
  if (!decision) return false;
  return decision?.type !== "fix_findings";
}

function latestAuthoritativeDecision(state: IssueState | null | undefined): HumanDecisionState | null {
  return latestAuthoritativeHumanDecision([
    ...(state?.humanDecisions ?? []),
    ...(state?.lastHumanDecision ? [state.lastHumanDecision] : [])
  ]);
}

function lifecycleStatusForHumanDecision(decision: HumanDecisionState): LifecycleStatus {
  if (decision.type === "fix_findings") return "human_continuation";
  if (decision.type === "proceed_to_merge_after_supervisor_fix") return "externally_fixed";
  return "supervisor_continuation";
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

function isRecoverablePartialWorkState(state: IssueState): boolean {
  const error = state.lastError?.toLowerCase() ?? "";
  return state.phase === "needs-input" || state.phase === "human-required" || state.lifecycleStatus === "implementation_failure" || state.reviewStatus === "human_required" || Boolean(state.nextRetryAt) || error.includes("stall") || error.includes("missing_handoff");
}
