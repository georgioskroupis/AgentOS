import { join, resolve } from "node:path";
import { exists } from "./fs-utils.js";
import { detectCapacityWait } from "./capacity-wait.js";
import { contextBudgetExceededMessage } from "./context-budget.js";
import { daemonPreflight, preflightAllowsDispatch, resolveRepoEnv, type DaemonPreflightResult, type RepoEnvLoadResult } from "./env.js";
import { GitHubClient, summarizeFeedback, type PullRequestStatus } from "./github.js";
import { readGitHubReviewContext } from "./github-context.js";
import { assertPullRequestUrlMatchesRepo, assertPullRequestUrlsMatchRepo } from "./github-repository.js";
import { verifyAndRecordAgentOwnedLifecycleEvidence } from "./orchestrator-agent-owned-evidence.js";
import { extractPullRequestUrls, extractHumanDecisionsFromComments, hasHumanDecision, isAuthoritativeHumanDecision, latestAuthoritativeHumanDecision, latestIssueComments, issueStateFromHandoff, IssueStateStore, latestHumanDecision, mergeHumanDecisions, reconcileHumanDecisionsForFetchedComments, mergeEligiblePullRequests, mergeTargetAmbiguityReason, mergeTargetPullRequest, primaryPullRequestUrl, pullRequestUrls } from "./issue-state.js";
import { schedulerBookkeepingHandoffComment } from "./lifecycle.js";
import { TrackerLifecycleController, type LifecycleTrackerUpdateResult } from "./lifecycle-controller.js";
import type { SchedulerSafetyWriteReason } from "./lifecycle-events.js";
import { JsonlLogger } from "./logging.js";
import type { MergeStateExtension } from "./merge-state-extension.js";
import { createMergeShepherdExtension } from "./merge-state-shepherd-adapter.js";
import { NullMonitorSink, type MonitorSink } from "./monitor-contracts.js";
import { createMonitorEmitter, type MonitorEmitter } from "./monitor-sink.js";
import { initialDaemonFreshnessState, isDaemonFreshnessStale } from "./daemon-freshness.js";
import { type ReadDaemonIdentityOptions } from "./daemon-identity.js";
import { summarizeText } from "./output-capture.js";
import { persistPhaseTimingToRun, phaseTimingLogPayload, timingStartNoLaterThan, timingStatusForRunResult, validationTimingFromEvidence, type PhaseTimingEventInput } from "./phase-timing.js";
import { createReviewFixerCiPostValidationExtension } from "./post-validation-review-adapter.js";
import type { PostValidationExtension } from "./post-validation-extension.js";
import { buildTargetedContextPack, pullRequestContextEntriesForUrls, pullRequestRefsForUrls } from "./context-pack.js";
import { existingImplementationAuditContext } from "./prompt-context.js";
import { formatRecoveryDiagnostics, inspectWorkspaceRecovery, type WorkspaceRecoveryDiagnostics } from "./recovery.js";
import { refreshOrchestratorDaemonRuntime } from "./orchestrator-daemon-runtime.js";
import { approvedPrLandingPreflightBlock, daemonPreflightWithLandingCredentialCheck, mergeShepherdLandingPreflightBlock, noPrMergeApprovalComment } from "./orchestrator-landing-preflight.js";
import { evaluateOrchestratorStartupPreflight, type OrchestratorStartupPreflightResult } from "./orchestrator-startup-preflight.js";
import { recordSingletonPreflightFailure } from "./orchestrator-singleton-preflight.js";
import { reviewIterationFinishedMonitorEvent, reviewIterationStartedMonitorEvent, withRunnerActivityMonitorContext, writeModelFinishedMonitorEvent, writeTurnCompletedMonitorEvent, writeTurnStartedMonitorEvent, writeValidationCommandMonitorEvents } from "./orchestrator-monitor-events.js";
import { emitPreDispatchMonitorPause } from "./orchestrator-pre-dispatch-monitor.js";
import { markLinearPlanningRecommended } from "./orchestrator-planning-guardrail.js";
import { moveIssueToRunningState } from "./orchestrator-run-start-state-sync.js";
import { handoffRunnerStreamStopPresentation, nonDispatchableRunnerStreamStopPresentation, TERMINAL_RUNNER_STREAM_STOP_REASON, HANDOFF_RUNNER_STREAM_STOP_REASON } from "./orchestrator-runner-stop-presentation.js";
import { readRuntimeRetryForIssue, retryBackoffFinishMetadata, runtimeRetryToMemory, type RetryEntry } from "./orchestrator-retry.js";
import { scheduleCapacityWait as scheduleCapacityWaitRetry } from "./orchestrator-capacity-wait.js";
import { recordContextBudgetForIssue } from "./orchestrator-context-budget.js";
import { safeGuardrailErrorMessage } from "./orchestrator-guardrail-errors.js";
import { capacityWaitScheduledCommentBody, needsInputCommentBody, recoveryNeededCommentBody, retryScheduledCommentBody, runFailedCommentBody, runStartedCommentBody } from "./orchestrator-lifecycle-comments.js";
import { autoRecoverPushedWork, finalizeCleanPushedWorkAfterRunnerStop, publishCleanRecoveryBranchIfSafe } from "./orchestrator-pushed-work-recovery.js";
import { isSupervisorContinuationPaused, latestAuthoritativeDecision, lifecycleStatusForHumanDecision, recoverablePartialWorkStatePatch, sleep } from "./orchestrator-recovery-actions.js";
import { schedulerSafetyCommentIssue, schedulerSafetyMoveIssue } from "./orchestrator-scheduler-safety.js";
import { completedDispatchStopReason, completionMarker, displayAttempt, isLocallyCompletedState, isLocallySettledIssueState, isNoPrHandoffApproved, isStateIn, issueFromRunSummary, issueFromState, readHandoff, runningAllowedStates, uniqueStrings, validationFailureMessage, workspaceFromRuntime } from "./orchestrator-state-helpers.js";
import { allowsImplementationContinuation, formatHumanDecision, formatLinearComment, GUARDRAIL_LINEAR_COMMENT_LIMIT, RECENT_LINEAR_COMMENT_LIMIT, refreshMergeShepherdHumanDecisionsIfNeeded } from "./orchestrator-human-decisions.js";
import { alreadyMergedIssuePatch, dependencyDispatchStopPatch, isSyntheticTimingRunMissingSummary, terminalHeadPatch, terminalWaitPhaseFinishes, terminalWorkspaceWarning } from "./orchestrator-terminal.js";
import { detectExternalHumanReviewStateDrift, recordExternalHumanReviewStateDrift } from "./orchestrator-state-drift.js";
import { dependencyDispatchStop, isPreRunDispatchSkipStop, trackerDispatchStop } from "./orchestrator-tracker-guard.js";
import { categorizeRunError, isDependencyDispatchStop, isDispatchTerminalStop, isHumanInputStop } from "./run-errors.js";
import { CodexAppServerRunner } from "./runner/app-server.js";
import { RunArtifactStore, type RunPhaseTiming, type RunSummary, type RunTimingPhase, type RunTimingStatus } from "./runs.js";
import { RuntimeStateStore, type RuntimeActiveRun, type RuntimeRecoverySummary } from "./runtime-state.js";
import { logPreDispatchScopeReport, scopeReportStateFromReport, type PreDispatchScopeReport } from "./scope-report.js";
import { verifyValidationEvidence } from "./validation.js";
import { validationRunContext, verifyHandoffValidationEvidence } from "./orchestrator-validation.js";
import { loadWorkflow, renderPrompt, resolveServiceConfig, validateDispatchConfig } from "./workflow.js";
import { createWorkspaceForRun } from "./orchestrator-workspace-bootstrap.js";
import { createTrackerCapabilitySet } from "./tracker-adapters.js";
import { splitTrackerCapabilities, type AgentLifecycleWriter, type SchedulerSafetyWriter, type TrackerReader } from "./tracker-boundaries.js";
import { recoverWorkspaceLocks, WorkspaceManager } from "./workspace.js";
import type { AgentEvent, AgentRunResult, AgentRunner, ContextBudgetState, ContextBudgetTurnKind, HumanDecisionState, Issue, IssueComment, IssueState, LifecycleStatus, ServiceConfig, WorkflowDefinition, Workspace } from "./types.js";
export interface OrchestratorOptions { repoRoot: string; workflowPath: string; tracker?: TrackerReader; schedulerSafetyWriter?: SchedulerSafetyWriter; agentLifecycleWriter?: AgentLifecycleWriter; runner?: AgentRunner; logger?: JsonlLogger; env?: NodeJS.ProcessEnv; maxConcurrentAgents?: number; daemonSingletonGuardOptions?: ReadDaemonIdentityOptions; monitorSink?: MonitorSink; postValidationExtension?: PostValidationExtension; mergeStateExtension?: MergeStateExtension; }
export interface OrchestratorRunOptions { dispatchLimit?: number; }
export interface OrchestratorRunSummary { dispatched: number; retryDispatched: number; candidateDispatched: number; candidates: number; }
interface RunningEntry { issue: Issue; startedAt: number; runId: string | null; lastCodexEventAt: number | null; abortController: AbortController; promise: Promise<void>; }

export class Orchestrator {
  private workflow!: WorkflowDefinition;
  private config!: ServiceConfig;
  private tracker!: TrackerReader;
  private runner!: AgentRunner;
  private lifecycleController!: TrackerLifecycleController;
  private logger: JsonlLogger;
  private monitorEmitter: MonitorEmitter;
  private runArtifacts: RunArtifactStore;
  private runtimeState: RuntimeStateStore;
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retries = new Map<string, RetryEntry>();
  private completedMarkers = new Map<string, string>();
  private startupCleanupDone = false;
  private startupReconstructionDone = false;
  private daemonStartedAt = new Date().toISOString();
  private daemonFreshness = initialDaemonFreshnessState();
  private freshnessWarningMarker: string | null = null;
  private repoEnv: RepoEnvLoadResult | null = null;
  private preflight: DaemonPreflightResult | null = null;
  private startupPreflight: OrchestratorStartupPreflightResult | null = null;
  private startupSingletonPreflightDone = false;
  private preflightWarningMarker: string | null = null;
  private postValidationExtension: PostValidationExtension;
  private mergeStateExtension: MergeStateExtension;
  constructor(private readonly options: OrchestratorOptions) {
    this.logger = options.logger ?? new JsonlLogger(resolve(options.repoRoot));
    this.monitorEmitter = createMonitorEmitter({ sink: options.monitorSink ?? new NullMonitorSink(), logger: this.logger });
    this.runArtifacts = new RunArtifactStore(resolve(options.repoRoot));
    this.runtimeState = new RuntimeStateStore(resolve(options.repoRoot));
    this.postValidationExtension = options.postValidationExtension ?? createReviewFixerCiPostValidationExtension({
      repoRoot: this.options.repoRoot,
      config: () => this.config,
      runner: () => this.runner,
      logger: this.logger,
      recordIssueState: (issue, patch) => this.recordIssueState(issue, patch),
      commentIssue: (issue, body) => this.commentIssue(issue, body),
      startRunPhase: (runId, issue, phase, label, metadata) => this.startRunPhase(runId, issue, phase, label, metadata),
      finishRunPhase: (runId, issue, timing, status, metadata) => this.finishRunPhase(runId, issue, timing, status, metadata),
      recordContextBudget: (issue, runId, kind, prompt) => this.recordContextBudget(issue, runId, kind, prompt),
      writeRunEvent: (runId, entry) => this.writeRunEvent(runId, entry),
      markRunningActivity: (issueId, timestamp) => this.markRunningActivity(issueId, timestamp)
    });
    this.mergeStateExtension = options.mergeStateExtension ?? createMergeShepherdExtension({
      repoRoot: this.options.repoRoot,
      config: () => this.config,
      preflight: () => this.preflight,
      tracker: { fetchCandidates: (states) => this.tracker.fetchCandidates(states) },
      runtimeState: this.runtimeState,
      retries: this.retries,
      logger: this.logger,
      fetchIssueComments: (issue) => this.fetchDispatchGuardrailIssueComments(issue),
      ingestHumanDecisions: (issue, state, comments, options) => this.ingestHumanDecisions(issue, state, comments, options),
      recordIssueState: (issue, patch) => this.recordIssueState(issue, patch),
      commentIssue: (issue, body, key) => this.commentIssue(issue, body, key),
      moveIssue: (issue, stateName) => this.moveIssue(issue, stateName),
      schedulerSafetyMoveIssue: (issue, stateName, safetyReason) => schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName, safetyReason }),
      finishOpenRunPhase: (runId, issue, phase, status, finishedAt, metadata) => this.finishOpenRunPhase(runId, issue, phase, status, finishedAt, metadata),
      writePhaseTimingEvent: (issue, input) => this.writePhaseTimingEvent(issue, input),
      refreshDaemonRuntimeState: (options) => this.refreshDaemonRuntimeState(options)
    });
  }
  async reload(): Promise<void> {
    const resolvedEnv = await resolveRepoEnv(resolve(this.options.repoRoot), this.options.env ?? process.env);
    this.repoEnv = resolvedEnv.repoEnv;
    this.workflow = await loadWorkflow(this.options.workflowPath);
    this.config = resolveServiceConfig(this.workflow, resolvedEnv.env);
    const credentialPreflight = await daemonPreflightWithLandingCredentialCheck(this.config, daemonPreflight(this.config, this.repoEnv), resolve(this.options.repoRoot));
    if (this.startupPreflight?.daemonPreflight.status === "singleton_conflict") {
      this.preflight = this.startupPreflight.daemonPreflight;
    } else if (!this.startupSingletonPreflightDone) {
      this.startupPreflight = await evaluateOrchestratorStartupPreflight({
        repoRoot: resolve(this.options.repoRoot),
        daemonPreflight: credentialPreflight,
        singletonGuardOptions: this.options.daemonSingletonGuardOptions
      });
      this.startupSingletonPreflightDone = true;
      this.preflight = this.startupPreflight.daemonPreflight;
    } else {
      this.preflight = credentialPreflight;
    }
    if (this.options.maxConcurrentAgents != null && Number.isInteger(this.options.maxConcurrentAgents) && this.options.maxConcurrentAgents > 0) {
      this.config.agent.maxConcurrentAgents = Math.min(this.config.agent.maxConcurrentAgents, this.options.maxConcurrentAgents);
    }
    const defaultCapabilities = this.options.tracker && this.options.schedulerSafetyWriter && this.options.agentLifecycleWriter ? null : this.options.tracker ? splitTrackerCapabilities(this.options.tracker) : createTrackerCapabilitySet(this.config);
    this.tracker = this.options.tracker ?? defaultCapabilities!.reader;
    this.lifecycleController = new TrackerLifecycleController({ config: this.config, reader: this.tracker, schedulerSafetyWriter: this.options.schedulerSafetyWriter ?? defaultCapabilities!.schedulerSafetyWriter, agentLifecycleWriter: this.options.agentLifecycleWriter ?? defaultCapabilities!.agentLifecycleWriter, logger: this.logger });
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
    if (await recordSingletonPreflightFailure(this.singletonPreflightFailureInput())) {
      return { dispatched: 0, retryDispatched: 0, candidateDispatched: 0, candidates: 0 };
    }
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
    await this.mergeStateExtension.processMergeState();
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
    if (await recordSingletonPreflightFailure(this.singletonPreflightFailureInput())) {
      throw new Error(this.preflight?.message ?? "daemon singleton preflight failed");
    }
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
  private singletonPreflightFailureInput(): Parameters<typeof recordSingletonPreflightFailure>[0] {
    return { daemonStartedAt: this.daemonStartedAt, workflow: this.workflow, preflight: this.preflight, repoEnv: this.repoEnv, runtimeState: this.runtimeState, logger: this.logger, startupPreflight: this.startupPreflight };
  }

  private async writeRunEvent(runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }): Promise<void> {
    const payload = { ...entry, runId, timestamp: entry.timestamp ?? new Date().toISOString() };
    await this.logger.write(payload);
    await this.runArtifacts.writeEvent(runId, payload);
    await this.monitorEmitter.emit(runId, payload);
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
    const repoRoot = resolve(this.options.repoRoot);
    const state = await new IssueStateStore(repoRoot).read(issue.identifier).catch(() => null);
    if (await isSyntheticTimingRunMissingSummary(repoRoot, state, runId)) return false;
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

  private async recordContextBudget(issue: Issue, runId: string | null | undefined, kind: ContextBudgetTurnKind, prompt: string): Promise<ContextBudgetState> {
    return recordContextBudgetForIssue({
      repoRoot: resolve(this.options.repoRoot),
      config: this.config.contextBudget,
      issue,
      runId,
      kind,
      prompt,
      logger: this.logger,
      recordIssueState: (target, patch) => this.recordIssueState(target, patch),
      writeRunEvent: (targetRunId, entry) => this.writeRunEvent(targetRunId, entry)
    });
  }

  private async phaseTimingRunId(issue: Issue, explicitRunId?: string | null): Promise<string | null> {
    const repoRoot = resolve(this.options.repoRoot);
    const runningRunId = this.running.get(issue.id)?.runId;
    const state = await new IssueStateStore(repoRoot).read(issue.identifier).catch(() => null);
    const runId = explicitRunId ?? runningRunId ?? state?.activeRunId ?? state?.lastRunId ?? null;
    if (!runId || (runId !== runningRunId && (await isSyntheticTimingRunMissingSummary(repoRoot, state, runId)))) return null;
    return runId;
  }

  private async refreshDaemonRuntimeState(options: { forceMainRefresh?: boolean } = {}): Promise<void> {
    const runtime = await refreshOrchestratorDaemonRuntime({
      repoRoot: this.options.repoRoot,
      workflow: this.workflow,
      config: this.config,
      daemonStartedAt: this.daemonStartedAt,
      daemonFreshness: this.daemonFreshness,
      freshnessWarningMarker: this.freshnessWarningMarker,
      preflight: this.preflight,
      repoEnv: this.repoEnv,
      runtimeState: this.runtimeState,
      logger: this.logger,
      preflightWarningMarker: this.preflightWarningMarker,
      forceMainRefresh: options.forceMainRefresh
    });
    this.daemonFreshness = runtime.daemonFreshness;
    this.freshnessWarningMarker = runtime.freshnessWarningMarker;
    this.preflightWarningMarker = runtime.preflightWarningMarker;
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
    let freshnessWarnings = isDaemonFreshnessStale(runtime.daemon?.freshnessStatus) ? 1 : 0;
    const terminalIdentifiers = new Set<string>();

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
        terminalIdentifiers.add(current.identifier);
        terminalIssues += 1;
        messages.push(`reconciled ${current.identifier} to terminal Linear state ${current.state}`);
        continue;
      }
      const issue = current ?? issueFromState(state);
      if (issue && (await this.classifyAlreadyMergedIssue(issue, state, "startup recovery: recorded pull request is already merged"))) {
        terminalIdentifiers.add(issue.identifier);
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
      if (terminalIdentifiers.has(active.identifier)) {
        if (active.runId) await this.runArtifacts.markRunCanceled(active.runId, "startup recovery: terminal issue already reconciled").catch(() => undefined);
        continue;
      }
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
      if (terminalIdentifiers.has(retry.identifier)) continue;
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
        await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.reviewState, safetyReason: "stale_run_recovery_required" });
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

    let recovery = workspacePath
      ? await inspectWorkspaceRecovery(resolve(this.options.repoRoot), {
          issueIdentifier: issue.identifier,
          workspacePath,
          headSha: state?.headSha ?? null,
          validation: state?.validation
        }).catch(() => null)
      : null;
    if (recovery?.recoverable) {
      recovery = await publishCleanRecoveryBranchIfSafe({ issue, recovery, state, repoRoot: this.options.repoRoot, logger: this.logger });
      if (await this.tryAutoRecoverPushedWork(issue, recovery, `${reason}; recovered clean pushed work`, state?.activeRunId ?? state?.lastRunId ?? runId ?? null)) {
        if (runId) await this.runArtifacts.markRunCanceled(runId, `${reason}; recovered clean pushed work`).catch(() => undefined);
        messages.push(`recovered clean pushed work for stale run ${issue.identifier}`);
        return { stale: true, terminal: false, retryRebuilt: false, messages };
      }
      const message = `recoverable partial work found: ${recovery.reasons.join("; ")}`;
      await this.recordIssueState(issue, recoverablePartialWorkStatePatch(message));
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      await this.markLinearRecoveryNeeded(issue, recovery, "stale_run_recovery_required");
      messages.push(`paused stale run for ${issue.identifier}: recoverable partial work`);
      return { stale: true, terminal: false, retryRebuilt: false, messages };
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
      await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.reviewState, safetyReason: "stale_run_recovery_required" });
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
      await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.needsInputState, safetyReason: "retry_budget_exhausted" });
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
    const dependencyStop = dependencyDispatchStop(this.config, latest);
    if (dependencyStop) {
      await this.runtimeState.clearIssue(latest.id);
      this.retries.delete(latest.id);
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: latest.id,
        issueIdentifier: latest.identifier,
        message: dependencyStop
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
    const drift = detectExternalHumanReviewStateDrift({ config: this.config, issue: latest, state, allowsImplementationContinuation: allowsImplementationContinuation(state, latestAuthoritativeDecision(state)) });
    if (drift) {
      await recordExternalHumanReviewStateDrift({
        issue: latest, drift,
        recordIssueState: (targetIssue, patch) => this.recordIssueState(targetIssue, patch), clearRuntimeIssue: async (issueId, issueIdentifier) => { await this.runtimeState.clearIssue(issueId, issueIdentifier); },
        deleteRetry: (issueId) => { this.retries.delete(issueId); }, logger: this.logger,
        commentIssue: (targetIssue, body, key) => schedulerSafetyCommentIssue({ controller: this.lifecycleController, issue: targetIssue, body, key, safetyReason: "pre_dispatch_safety_block" }), moveIssue: (targetIssue, stateName) => schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue: targetIssue, stateName, safetyReason: "pre_dispatch_safety_block" })
      });
      return null;
    }
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
    const scopeReport = await logPreDispatchScopeReport({ repoRoot: resolve(this.options.repoRoot), issue: latest, state, runtime: await this.runtimeState.read(), workspaceRoot: this.config.workspace.root, linearComments, logger: this.logger });
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
      return this.mergeStateExtension.processApprovedPullRequestLanding({ issue, state, mergeTarget });
    }

    if (state && !allowImplementationContinuation && isLocallyCompletedState(state)) {
      const message = completedDispatchStopReason(state);
      await this.recordDispatchGuardrailStop(issue, message, {
        phase: "completed",
        stopReason: message,
        lastError: undefined,
        errorCategory: undefined
      });
      await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.reviewState, safetyReason: "pre_dispatch_safety_block" });
      return true;
    }

    if (state && !allowImplementationContinuation && (state.reviewStatus === "human_required" || state.phase === "human-required")) {
      const message = "human-required issue needs a trusted structured decision before redispatch";
      await this.recordDispatchGuardrailStop(issue, message, {
        phase: "human-required",
        reviewStatus: "human_required",
        stopReason: message
      });
      await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.needsInputState, safetyReason: "pre_dispatch_safety_block" });
      return true;
    }

    let recovery = await this.dispatchRecoveryDiagnostics(issue, state, scopeReport);
    if (recovery?.recoverable) {
      recovery = await publishCleanRecoveryBranchIfSafe({ issue, recovery, state, repoRoot: this.options.repoRoot, logger: this.logger });
      if (await this.tryAutoRecoverPushedWork(issue, recovery, "dispatch recovery: clean pushed work was reconstructed before redispatch", state?.activeRunId ?? state?.lastRunId ?? null)) {
        return true;
      }
      const message = `recoverable partial work found: ${recovery.reasons.join("; ")}`;
      await this.recordIssueState(issue, recoverablePartialWorkStatePatch(message));
      await this.runtimeState.clearIssue(issue.id);
      this.retries.delete(issue.id);
      await this.markLinearRecoveryNeeded(issue, recovery, "pre_dispatch_safety_block");
      await this.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message,
        payload: recovery
      });
      await emitPreDispatchMonitorPause({
        monitorEmitter: this.monitorEmitter,
        issue,
        label: "Workspace recovery needed",
        message,
        reasonCode: "recovery_needed"
      });
      return true;
    }

    if (!allowImplementationContinuation && scopeReport?.dispatchAdvice.shouldBlock) {
      const message = scopeReport.dispatchAdvice.reason ?? "pre-dispatch scope guardrail blocked implementation dispatch";
      if (scopeReport.likelyLarge || scopeReport.evidence.planningReentry.status === "missing") {
        await markLinearPlanningRecommended({
          issue,
          report: scopeReport,
          config: this.config,
          lifecycleController: this.lifecycleController,
          monitorEmitter: this.monitorEmitter,
          recordDispatchGuardrailStop: (targetIssue, stopMessage, patch) => this.recordDispatchGuardrailStop(targetIssue, stopMessage, patch),
          writePhaseTimingEvent: (targetIssue, event) => this.writePhaseTimingEvent(targetIssue, event)
        });
      } else {
        await this.recordDispatchGuardrailStop(issue, message, {
          phase: "needs-input",
          stopReason: message,
          scopeReport: scopeReportStateFromReport(scopeReport)
        });
        await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.needsInputState, safetyReason: "pre_dispatch_safety_block" });
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
    await this.runtimeState.clearIssue(issue.id, issue.identifier);
    this.retries.delete(issue.id);
    await this.logger.write({ type: "dispatch_skipped", issueId: issue.id, issueIdentifier: issue.identifier, message });
    return state;
  }

  private async recordCommentReadDispatchStop(issue: Issue, error: Error): Promise<IssueState> {
    const safeError = safeGuardrailErrorMessage(error);
    const message = `could not read latest Linear comments before dispatch guardrails: ${safeError}`;
    return this.recordDispatchGuardrailStop(issue, message, {
      phase: "needs-input", lifecycleStatus: undefined, lastError: message, errorCategory: "prompt", stopReason: message
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
    await this.runtimeState.clearIssue(issue.id, issue.identifier);
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
    await this.runtimeState.clearIssue(issue.id, issue.identifier);
    this.retries.delete(issue.id);
    this.completedMarkers.set(issue.id, completionMarker(issue));
    if (!isStateIn(issue.state, this.config.tracker.terminalStates)) {
      await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.github.doneState, safetyReason: "terminal_cleanup_reconciliation" });
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
    if (dispatchStop && isPreRunDispatchSkipStop(this.config, dispatchStop)) {
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
    if (startStop && isPreRunDispatchSkipStop(this.config, startStop)) {
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
    const workspace = await createWorkspaceForRun({
      issue,
      attempt,
      runId,
      config: this.config,
      runtimeState: this.runtimeState,
      runArtifacts: this.runArtifacts,
      workspaceManager,
      writeRunEvent: (targetRunId, entry) => this.writeRunEvent(targetRunId, entry),
      recordIssueState: (targetIssue, patch) => this.recordIssueState(targetIssue, patch),
      schedulerSafetyCommentIssue: (targetIssue, body, key, safetyReason) => schedulerSafetyCommentIssue({ controller: this.lifecycleController, issue: targetIssue, body, key, safetyReason }),
      schedulerSafetyMoveIssue: (targetIssue, stateName, safetyReason) => schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue: targetIssue, stateName, safetyReason }),
      writePhaseTimingEvent: (targetIssue, event) => this.writePhaseTimingEvent(targetIssue, event)
    });
    if (!workspace) return;
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
        if (await this.tryFinalizeCleanPushedWorkAfterRunnerStop(issue, workspace, result, runId)) {
          return;
        }
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
            validation = await verifyHandoffValidationEvidence({ config: this.config, issue, handoff, workspacePath: workspace.path, runId });
            await writeValidationCommandMonitorEvents({ writeRunEvent: (targetRunId, entry) => this.writeRunEvent(targetRunId, entry), runId, issue, validation });
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
          if (this.config.lifecycle.mode === "agent-owned" && validation.state.status === "missing" && !(await verifyAndRecordAgentOwnedLifecycleEvidence({ config: this.config, tracker: this.tracker, logger: this.logger, runArtifacts: this.runArtifacts, runtimeState: this.runtimeState, stateStore, issue, workspace, runId, attempt, handoff, state: stateFromHandoff ? await stateStore.merge(issue.identifier, { ...stateFromHandoff, validation: validation.state }) : await stateStore.read(issue.identifier), validation: validation.state, result, recordIssueState: async (patch) => { await this.recordIssueState(issue, patch); }, forgetRetry: () => this.retries.delete(issue.id), forgetCompletionMarker: () => this.completedMarkers.delete(issue.id), writeRunEvent: (entry) => this.writeRunEvent(runId, entry) })).passed) return;
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
        let persistedState = stateFromHandoff
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
        if (this.config.lifecycle.mode === "agent-owned") {
          const verification = await verifyAndRecordAgentOwnedLifecycleEvidence({ config: this.config, tracker: this.tracker, logger: this.logger, runArtifacts: this.runArtifacts, runtimeState: this.runtimeState, stateStore, issue, workspace, runId, attempt, handoff, state: persistedState, validation: validation?.state ?? persistedState?.validation ?? null, result, recordIssueState: async (patch) => { await this.recordIssueState(issue, patch); }, forgetRetry: () => this.retries.delete(issue.id), forgetCompletionMarker: () => this.completedMarkers.delete(issue.id), writeRunEvent: (entry) => this.writeRunEvent(runId, entry) });
          persistedState = verification.state;
          if (!verification.passed) return;
        }
        const reviewedState = await this.postValidationExtension.afterValidation({ issue, workspace, state: persistedState, attempt, signal: abortController.signal, runId });
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
      const promptBudget = await this.recordContextBudget(issue, runId, "implementation", prompt);
      if (promptBudget.status === "exceeded") {
        return { status: "canceled", error: contextBudgetExceededMessage(promptBudget) };
      }
      await this.recordIssueState(issue, { phase: "streaming-turn" });
      const implementationTiming = await this.startRunPhase(runId, issue, "implementation", `implementation turn ${turnNumber}`, { turnNumber, maxTurns: this.config.agent.maxTurns });
      await writeTurnStartedMonitorEvent({ writeRunEvent: (targetRunId, entry) => this.writeRunEvent(targetRunId, entry), runId, issue, timing: implementationTiming, label: `implementation turn ${turnNumber}`, current: turnNumber, max: this.config.agent.maxTurns });
      try {
        result = await this.runner.run({
          issue,
          prompt,
          attempt,
          workspace,
          config: this.config, modelRouting: { role: "implementation", attempt: turnNumber },
          signal,
          onEvent: (event) => {
            this.markRunningActivity(issue.id, event.timestamp);
            void this.writeRunEvent(runId, { ...withRunnerActivityMonitorContext(event, implementationTiming), runId });
          }
        });
      } catch (error) {
        await this.finishRunPhase(runId, issue, implementationTiming, "failed", { turnNumber, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const handoffStop = await handoffRunnerStreamStopPresentation({ result, signal, workspace, issue });
      await writeModelFinishedMonitorEvent({ writeRunEvent: (targetRunId, entry) => this.writeRunEvent(targetRunId, entry), runId, issue, result, role: "implementation", attempt: turnNumber, ...(handoffStop ? { displayStatus: "succeeded" } : {}) });
      await writeTurnCompletedMonitorEvent({ writeRunEvent: (targetRunId, entry) => this.writeRunEvent(targetRunId, entry), runId, issue, timing: implementationTiming, label: `implementation turn ${turnNumber}`, current: turnNumber, result, max: this.config.agent.maxTurns, ...(handoffStop ? { displayResult: handoffStop.displayResult, message: `implementation turn ${turnNumber} handoff completed; runner stream stopped` } : {}) });
      await this.finishRunPhase(runId, issue, implementationTiming, handoffStop ? "completed" : timingStatusForRunResult(result), { turnNumber, resultStatus: result.status, ...(handoffStop ? { displayStatus: "succeeded", stopReason: HANDOFF_RUNNER_STREAM_STOP_REASON } : {}) });
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
    const runContext = validationRunContext(this.config, issue, runId);
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
      "Update the existing branch and PR. Reuse existing validation evidence when it already matches the current code head and validation reuse profile; rerun validation when code, workflow/config, trust, automation, risk profile, or evidence freshness changed."
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
        running.abortController.abort(TERMINAL_RUNNER_STREAM_STOP_REASON);
        await this.writePhaseTimingEvent(issue, {
          phase: "stall-cancel", status: "canceled",
          startedAt: new Date(running.lastCodexEventAt ?? running.startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          label: "terminal-state cancel", metadata: { state: issue.state }
        });
        await workspaceManager.remove(issue.identifier);
      } else if (!isStateIn(issue.state, runningAllowedStates(this.config))) {
        const streamStop = nonDispatchableRunnerStreamStopPresentation(issue.state, this.config);
        running.abortController.abort(streamStop.reason);
        await this.writePhaseTimingEvent(issue, {
          phase: "stall-cancel", status: streamStop.status,
          startedAt: new Date(running.lastCodexEventAt ?? running.startedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          label: streamStop.label, metadata: { state: issue.state, reason: streamStop.reason }
        });
      }
    }
    for (const entry of stale) {
      const elapsed = Date.now() - (entry.lastCodexEventAt ?? entry.startedAt);
      if (elapsed <= this.config.codex.stallTimeoutMs) continue;
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

  private isEligible(issue: Issue): boolean {
    if (!issue.id || !issue.identifier || !issue.title || !issue.state) return false;
    if (this.running.has(issue.id) || this.claimed.has(issue.id)) return false;
    if (this.retries.has(issue.id) && this.retries.get(issue.id)!.dueAtMs > Date.now()) return false;
    if (this.completedMarkers.get(issue.id) === completionMarker(issue)) return false;
    const state = issue.state.toLowerCase();
    if (!this.config.tracker.activeStates.map((item) => item.toLowerCase()).includes(state)) return false;
    if (this.config.tracker.terminalStates.map((item) => item.toLowerCase()).includes(state)) return false;
    return !dependencyDispatchStop(this.config, issue);
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
    } else if (isDependencyDispatchStop(reason)) {
      await this.recordDispatchGuardrailStop(latest, reason, dependencyDispatchStopPatch(runId));
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
    const capacityWait = detectCapacityWait(safeError);
    if (capacityWait) {
      const retry = await this.scheduleCapacityWait(issue, previousAttempt, safeError, capacityWait.resetAt, runId, workspace);
      await this.recordIssueState(issue, {
        lastError: safeError,
        errorCategory: "capacity-wait",
        lifecycleStatus: "implementation_failure",
        stopReason: `capacity_wait until ${capacityWait.resetAt}: ${safeError}`,
        retryAttempt: retry.attempt,
        nextRetryAt: new Date(retry.dueAtMs).toISOString()
      });
      await this.markLinearCapacityWaitScheduled(issue, workspace, retry, capacityWait.reason);
      return;
    }
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
      await this.markLinearFailed(issue, workspace, previousAttempt, safeError, "retry_budget_exhausted");
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

  private async scheduleCapacityWait(issue: Issue, previousAttempt: number | null, error: string | null, resetAt: string, runId?: string, workspace?: Workspace): Promise<RetryEntry> {
    return scheduleCapacityWaitRetry({
      issue,
      previousAttempt,
      error,
      resetAt,
      runId,
      workspace,
      retries: this.retries,
      runtimeState: this.runtimeState,
      maxAttempts: this.config.agent.maxRetryAttempts,
      writePhaseTimingEvent: (target, event) => this.writePhaseTimingEvent(target, event)
    });
  }

  private async finishRetryBackoff(retry: RetryEntry, issue: Issue, status: Exclude<RunTimingStatus, "running" | "waiting">, reason: string, finishedAt = new Date().toISOString()): Promise<void> {
    await this.finishOpenRunPhase(retry.runId, issue, "retry-backoff", status, finishedAt, retryBackoffFinishMetadata(retry, reason));
  }

  private async markLinearStarted(issue: Issue, workspace: Workspace, attempt: number | null): Promise<boolean> {
    const moveResult = await moveIssueToRunningState({ config: this.config, lifecycleController: this.lifecycleController, issue, moveIssue: (targetIssue, stateName) => this.moveIssue(targetIssue, stateName) });
    if (moveResult === "blocked") return false;
    await this.commentIssue(issue, runStartedCommentBody(workspace, displayAttempt(attempt)), "run_started");
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
    await this.commentIssue(
      issue,
      [
        schedulerBookkeepingHandoffComment({
          issueIdentifier: issue.identifier,
          workspacePath: workspace.path,
          reviewStatus: state?.reviewStatus,
          reviewIteration: state?.reviewIteration
        }),
        process.env.VITEST === "true" && this.config.lifecycle.maturityAcknowledgement === "test-only-orchestrator-lifecycle-fixture" && handoff ? handoff : null
      ].filter((line): line is string => Boolean(line)).join("\n\n"),
      "run_handoff"
    );
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
    await this.commentIssue(issue, retryScheduledCommentBody(workspace, retry, this.config.agent.maxRetryAttempts), "retry_scheduled");
  }

  private async markLinearCapacityWaitScheduled(issue: Issue, workspace: Workspace, retry: RetryEntry, reason: string): Promise<void> {
    await this.commentIssue(issue, capacityWaitScheduledCommentBody(workspace, retry, this.config.agent.maxRetryAttempts, reason), "capacity_wait_scheduled");
  }
  private async markLinearFailed(issue: Issue, workspace: Workspace, attempt: number | null, error: string, safetyReason?: SchedulerSafetyWriteReason): Promise<void> {
    const recovery = await inspectWorkspaceRecovery(resolve(this.options.repoRoot), {
      issueIdentifier: issue.identifier,
      workspacePath: workspace.path
    }).catch(() => null);
    const body = runFailedCommentBody({ workspace, attemptLabel: displayAttempt(attempt), error, recoveryText: recovery ? formatRecoveryDiagnostics(recovery).join("\n") : null });
    if (safetyReason) {
      await schedulerSafetyCommentIssue({ controller: this.lifecycleController, issue, body, key: "run_failed", safetyReason });
      await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.needsInputState, safetyReason });
    } else {
      await this.commentIssue(issue, body, "run_failed");
      await this.moveIssue(issue, this.config.tracker.needsInputState);
    }
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
  private async markLinearRecoveryNeeded(issue: Issue, recovery: WorkspaceRecoveryDiagnostics, safetyReason?: SchedulerSafetyWriteReason): Promise<void> {
    if (safetyReason) {
      await schedulerSafetyCommentIssue({ controller: this.lifecycleController, issue, body: recoveryNeededCommentBody(formatRecoveryDiagnostics(recovery).join("\n")), key: "recovery_needed", safetyReason });
      await schedulerSafetyMoveIssue({ controller: this.lifecycleController, issue, stateName: this.config.tracker.needsInputState, safetyReason });
    } else {
      await this.commentIssue(issue, recoveryNeededCommentBody(formatRecoveryDiagnostics(recovery).join("\n")), "recovery_needed");
      await this.moveIssue(issue, this.config.tracker.needsInputState);
    }
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

  private async tryAutoRecoverPushedWork(issue: Issue, recovery: WorkspaceRecoveryDiagnostics, reason: string, runId: string | null = null): Promise<boolean> {
    return autoRecoverPushedWork({
      issue,
      recovery,
      reason,
      repoRoot: this.options.repoRoot,
      config: this.config,
      runId,
      logger: this.logger,
      markRunningActivity: (issueId, timestamp) => this.markRunningActivity(issueId, timestamp),
      markSucceeded: async (workspace, handoff, state) => {
        await this.markLinearSucceeded(issue, workspace, handoff, state);
        this.completedMarkers.set(issue.id, completionMarker(issue));
      }
    });
  }

  private async tryFinalizeCleanPushedWorkAfterRunnerStop(issue: Issue, workspace: Workspace, result: AgentRunResult, runId: string): Promise<boolean> {
    const state = await new IssueStateStore(resolve(this.options.repoRoot)).read(issue.identifier);
    return finalizeCleanPushedWorkAfterRunnerStop({
      issue,
      workspace,
      result,
      runId,
      state,
      repoRoot: this.options.repoRoot,
      config: this.config,
      logger: this.logger,
      markRunningActivity: (issueId, timestamp) => this.markRunningActivity(issueId, timestamp),
      markSucceeded: async (targetWorkspace, handoff, recoveredState) => {
        await this.markLinearSucceeded(issue, targetWorkspace, handoff, recoveredState);
        this.completedMarkers.set(issue.id, completionMarker(issue));
      },
      writeRunHandoff: (handoff) => this.runArtifacts.writeHandoff(runId, handoff),
      writeRunEvent: (entry) => this.writeRunEvent(runId, entry),
      completeRun: async (recoveredResult) => { await this.runArtifacts.completeRun(runId, recoveredResult); }
    });
  }

  private async markLinearNeedsInput(issue: Issue, workspace: Workspace, attempt: number | null, error: string): Promise<void> {
    await this.commentIssue(issue, needsInputCommentBody(workspace, displayAttempt(attempt), error), "run_needs_input");
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

  private async moveIssue(issue: Issue, stateName: string | null): Promise<LifecycleTrackerUpdateResult> {
    if (!stateName) return "unsupported";
    const result = await this.lifecycleController.record({
      schemaVersion: 1,
      actor: "extension",
      type: "state_transition_requested",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueState: issue.state,
      source: "orchestrator",
      requestedState: stateName,
      createdAt: new Date().toISOString()
    });
    return result.trackerUpdateResult ?? "unsupported";
  }
  private async commentIssue(issue: Issue, body: string, key?: string, kind: "bookkeeping" | "substantive" = "bookkeeping"): Promise<void> {
    await this.lifecycleController.record({
      schemaVersion: 1,
      actor: "extension",
      type: "progress_comment",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueState: issue.state,
      source: "orchestrator",
      commentBody: body,
      commentKey: key,
      commentKind: kind,
      createdAt: new Date().toISOString()
    });
  }
}
