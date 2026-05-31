import { resolve } from "node:path";
import type { DaemonPreflightResult } from "./env.js";
import { evaluateMergeReadiness, GitHubClient } from "./github.js";
import { assertPullRequestUrlMatchesRepo } from "./github-repository.js";
import { IssueStateStore, mergeEligiblePullRequests, mergeTargetAmbiguityReason, mergeTargetPullRequest } from "./issue-state.js";
import { evaluateLandingPolicyForConfig, formatLandingPolicyResult } from "./landing-policy.js";
import { landingFreshnessPatch } from "./landing-preflight.js";
import type { SchedulerSafetyWriteReason } from "./lifecycle-events.js";
import type { JsonlLogger } from "./logging.js";
import { type ApprovedPullRequestLandingInput, type MergeStateExtension } from "./merge-state-extension.js";
import { refreshMergeShepherdHumanDecisionsIfNeeded } from "./orchestrator-human-decisions.js";
import { handleMergeBranchFreshness } from "./orchestrator-branch-update.js";
import { approvedPrLandingPreflightBlock, mergeShepherdLandingPreflightBlock, noPrMergeApprovalComment, runLandingShepherdGate } from "./orchestrator-landing-preflight.js";
import { mergeFailedCommentBody, mergeFailureActiveRepairRoute, mergeFailureActiveRepairStatePatch, mergeWaitingCommentBody, type MergeFailureRoute } from "./orchestrator-lifecycle-comments.js";
import { cleanupMergedPullRequest } from "./orchestrator-merge-cleanup.js";
import { recoverMergeMetadataFromWorkspaceEvidence } from "./orchestrator-merge-recovery.js";
import { markDraftPullRequestReadyIfConfigured } from "./orchestrator-pr-ready.js";
import { isNoPrHandoffApproved } from "./orchestrator-state-helpers.js";
import { alreadyMergedIssuePatch, completeRecordedMergeTerminal, isRecordedMergeTerminal } from "./orchestrator-terminal.js";
import { approvedReviewValidationBlockReason } from "./review-budget-orchestration.js";
import { isReviewSplitRecommendationBlocking, reviewSupervisorMergeDecision } from "./review-budget.js";
import { timingStartNoLaterThan, type PhaseTimingEventInput } from "./phase-timing.js";
import type { RunTimingPhase, RunTimingStatus } from "./runs.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import { safeGuardrailErrorMessage } from "./orchestrator-guardrail-errors.js";
import type { TrackerReader } from "./tracker-boundaries.js";
import type { Issue, IssueComment, IssueState, ServiceConfig } from "./types.js";

export interface MergeShepherdExtensionDeps {
  repoRoot: string;
  config(): ServiceConfig;
  preflight(): DaemonPreflightResult | null;
  tracker: Pick<TrackerReader, "fetchCandidates">;
  runtimeState: RuntimeStateStore;
  retries: Pick<Map<string, unknown>, "delete">;
  logger: JsonlLogger;
  fetchIssueComments(issue: Issue): Promise<IssueComment[] | null>;
  ingestHumanDecisions(issue: Issue, state: IssueState | null, comments: IssueComment[], options: { authoritativeCommentSet?: boolean }): Promise<IssueState | null>;
  recordIssueState(issue: Issue, patch: Partial<IssueState>): Promise<IssueState>;
  commentIssue(issue: Issue, body: string, key?: string): Promise<void>;
  moveIssue(issue: Issue, stateName: string | null): Promise<unknown>;
  schedulerSafetyMoveIssue(issue: Issue, stateName: string, safetyReason: SchedulerSafetyWriteReason): Promise<unknown>;
  finishOpenRunPhase(
    runId: string | null | undefined,
    issue: Issue,
    phase: RunTimingPhase,
    status: Exclude<RunTimingStatus, "running">,
    finishedAt: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean>;
  writePhaseTimingEvent(issue: Issue, input: PhaseTimingEventInput): Promise<void>;
  refreshDaemonRuntimeState(options?: { forceMainRefresh?: boolean }): Promise<void>;
}

export function createMergeShepherdExtension(deps: MergeShepherdExtensionDeps): MergeStateExtension {
  const waitingMarkers = new Map<string, string>();
  const repoRoot = () => resolve(deps.repoRoot);

  async function markMergeWaiting(issue: Issue, prUrl: string, reason: string, runId?: string | null): Promise<void> {
    const marker = `${issue.updated_at ?? ""}:${reason}`;
    if (waitingMarkers.get(issue.id) === marker) return;
    waitingMarkers.set(issue.id, marker);
    await deps.commentIssue(issue, mergeWaitingCommentBody(prUrl, reason), "merge_waiting");
    await deps.logger.write({
      type: "merge_waiting",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl }
    });
    await deps.writePhaseTimingEvent(issue, {
      phase: "ci-wait",
      status: "waiting",
      runId,
      startedAt: issue.updated_at ?? undefined,
      label: "ci wait started",
      metadata: { prUrl, reason }
    });
  }

  async function markMergeFailed(issue: Issue, reason: string, options: { prUrl?: string | null; runId?: string | null; route?: MergeFailureRoute; reviewGate?: boolean } = {}): Promise<void> {
    const config = deps.config();
    const prUrl = options.prUrl ?? undefined;
    const route = options.route ?? "review";
    const targetState = route === "needs-input" ? config.tracker.needsInputState : route === "running" ? config.tracker.runningState : config.tracker.reviewState;
    if (route === "running") await deps.recordIssueState(issue, mergeFailureActiveRepairStatePatch(reason, await new IssueStateStore(repoRoot()).read(issue.identifier)));
    await deps.commentIssue(
      issue,
      mergeFailedCommentBody({ prUrl, reason, route, targetState, reviewGate: options.reviewGate }),
      "merge_failed"
    );
    await deps.moveIssue(issue, targetState);
    if (route === "needs-input") {
      await deps.writePhaseTimingEvent(issue, {
        phase: "needs-input",
        status: "waiting",
        runId: options.runId,
        label: "merge needs structured human decision",
        metadata: { needsInputState: config.tracker.needsInputState, reason, ...(prUrl ? { prUrl } : {}) }
      });
    } else if (route === "review") {
      await deps.writePhaseTimingEvent(issue, {
        phase: "human-wait",
        status: "waiting",
        runId: options.runId,
        label: "human review wait restarted",
        metadata: { reviewState: config.tracker.reviewState, reason, ...(prUrl ? { prUrl } : {}) }
      });
    }
    await deps.logger.write({
      type: "merge_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: reason,
      payload: { prUrl, route, targetState }
    });
  }

  async function recordApprovedPrGuardrailStop(issue: Issue, message: string, patch: Partial<IssueState>): Promise<IssueState> {
    const state = await deps.recordIssueState(issue, {
      activeRunId: undefined,
      nextRetryAt: undefined,
      retryAttempt: undefined,
      ...patch,
      stopReason: patch.stopReason ?? message
    });
    await deps.runtimeState.clearIssue(issue.id, issue.identifier);
    deps.retries.delete(issue.id);
    await deps.logger.write({ type: "dispatch_skipped", issueId: issue.id, issueIdentifier: issue.identifier, message });
    return state;
  }

  async function validateDispatchPullRequestTarget(issue: Issue, prUrl: string): Promise<boolean> {
    try {
      await assertPullRequestUrlMatchesRepo(repoRoot(), prUrl);
      return true;
    } catch (error) {
      const message = safeGuardrailErrorMessage(error);
      await recordApprovedPrGuardrailStop(issue, message, {
        phase: "human-required",
        reviewStatus: "human_required",
        lastError: message,
        errorCategory: "prompt",
        stopReason: message
      });
      const reviewState = deps.config().tracker.reviewState;
      if (reviewState) await deps.schedulerSafetyMoveIssue(issue, reviewState, "pre_dispatch_safety_block");
      return false;
    }
  }

  async function processApprovedPullRequestLanding(input: ApprovedPullRequestLandingInput): Promise<boolean> {
    const { issue, state, mergeTarget } = input;
    const config = deps.config();
    await deps.runtimeState.clearIssue(issue.id, issue.identifier);
    deps.retries.delete(issue.id);
    const targetValid = await validateDispatchPullRequestTarget(issue, mergeTarget.url);
    if (!targetValid) return true;
    const landing = evaluateLandingPolicyForConfig(config);
    if (!landing.enabled) {
      const message = `approved PR landing ${formatLandingPolicyResult(landing)}`;
      await deps.recordIssueState(issue, { phase: state.phase, mergeTargetUrl: mergeTarget.url, mergeTargetRole: mergeTarget.role ?? "primary", stopReason: message, nextRetryAt: undefined, retryAttempt: undefined });
      await deps.logger.write({ type: `landing_${landing.status}`, issueId: issue.id, issueIdentifier: issue.identifier, message, payload: { prUrl: mergeTarget.url, landing } });
      if (config.tracker.reviewState) await deps.schedulerSafetyMoveIssue(issue, config.tracker.reviewState, "pre_dispatch_safety_block");
      return true;
    }
    const github = new GitHubClient(config.github.command);
    const pr = await github.getPullRequest(mergeTarget.url, repoRoot()).catch(async (error: Error) => {
      await deps.logger.write({
        type: "dispatch_skipped",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `approved PR exists but GitHub status could not be read: ${error.message}`
      });
      return null;
    });
    if (pr?.merged) {
      const terminalAt = new Date().toISOString();
      await deps.recordIssueState(issue, alreadyMergedIssuePatch(state, pr, terminalAt, "dispatch skipped because approved PR is already merged"));
      await deps.runtimeState.clearIssue(issue.id, issue.identifier);
      deps.retries.delete(issue.id);
      if (config.github.doneState) await deps.schedulerSafetyMoveIssue(issue, config.github.doneState, "terminal_cleanup_reconciliation");
      await deps.logger.write({
        type: "issue_already_merged_reconciled",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: "dispatch skipped because approved PR is already merged",
        payload: { prUrl: pr.url }
      });
      return true;
    }
    const refreshedState = pr ? await deps.recordIssueState(issue, landingFreshnessPatch(state, pr, config.github.requireChecks)) : state;
    const landingBlock = pr ? await approvedPrLandingPreflightBlock({ config, preflight: deps.preflight(), runtimeState: deps.runtimeState, state: refreshedState, pullRequest: pr, mergeTarget }) : null;
    if (landingBlock) {
      await deps.recordIssueState(issue, landingBlock.statePatch);
      await deps.logger.write({ type: `landing_preflight_${landingBlock.status}`, issueId: issue.id, issueIdentifier: issue.identifier, message: landingBlock.message, payload: landingBlock.payload });
      if (landingBlock.status === "blocked" && config.tracker.reviewState) await deps.schedulerSafetyMoveIssue(issue, config.tracker.reviewState, "pre_dispatch_safety_block");
      return true;
    }
    const readyPr = pr
      ? await markDraftPullRequestReadyIfConfigured({
          issue,
          github,
          repoRoot: repoRoot(),
          pr,
          prUrl: mergeTarget.url,
          state: refreshedState,
          requireChecks: config.github.requireChecks,
          markDraftReady: config.github.markDraftReady,
          reason: "approved PR landing preflight passed",
          recordIssueState: deps.recordIssueState,
          commentIssue: deps.commentIssue,
          logger: deps.logger
        })
      : pr;
    const readiness = readyPr ? evaluateMergeReadiness(readyPr, config.github.requireChecks) : null;
    const message = readiness?.ready
      ? "approved PR is merge-ready; moved issue to Merging instead of redispatching implementation"
      : `approved PR awaits merge readiness${readiness ? `: ${readiness.reason}` : ""}`;
    await deps.recordIssueState(issue, {
      phase: readiness?.ready ? "merge" : state.phase,
      mergeTargetUrl: mergeTarget.url,
      mergeTargetRole: mergeTarget.role ?? "primary",
      stopReason: message,
      nextRetryAt: undefined,
      retryAttempt: undefined
    });
    await deps.logger.write({
      type: "dispatch_skipped",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message,
      payload: { prUrl: mergeTarget.url, readiness }
    });
    if (readiness?.ready && config.tracker.mergeState) await deps.schedulerSafetyMoveIssue(issue, config.tracker.mergeState, "pre_dispatch_safety_block");
    return true;
  }

  async function processMergeState(): Promise<void> {
    await runLandingShepherdGate({
      config: deps.config(),
      preflight: deps.preflight(),
      runtimeState: deps.runtimeState,
      logger: deps.logger,
      shepherd: async () => {
        const mergeState = deps.config().tracker.mergeState;
        if (!mergeState) return;
        const issues = await deps.tracker.fetchCandidates([mergeState]);
        for (const issue of issues) {
          await shepherdMergeIssue(issue);
        }
      }
    });
  }

  async function shepherdMergeIssue(issue: Issue): Promise<void> {
    const config = deps.config();
    const timingStartedAt = new Date().toISOString();
    let timingStatus: RunTimingStatus = "completed";
    let timingLabel = "merge shepherding completed";
    let timingMetadata: Record<string, unknown> = {};
    const stateStore = new IssueStateStore(repoRoot());
    let state = await stateStore.read(issue.identifier);
    await deps.finishOpenRunPhase(state?.lastRunId, issue, "human-wait", "completed", timingStartNoLaterThan(issue.updated_at, timingStartedAt), { reason: "issue entered merge state" });
    if (config.review.enabled) {
      state = await refreshMergeShepherdHumanDecisionsIfNeeded({
        issue,
        state,
        fetchIssueComments: deps.fetchIssueComments,
        ingestHumanDecisions: deps.ingestHumanDecisions,
        logger: deps.logger
      });
    }
    const recovered = await recoverMergeMetadataFromWorkspaceEvidence({ issue, state, repoRoot: repoRoot(), logger: deps.logger });
    state = recovered.state;
    const mergeTarget = mergeTargetPullRequest(state);
    const mergePr = mergeTarget?.url ?? null;
    const mergeEligiblePrs = mergeEligiblePullRequests(state);
    try {
      if (state && !mergePr && isNoPrHandoffApproved(state) && mergeEligiblePrs.length === 0) {
        timingMetadata = { result: "approved no-PR handoff" };
        await deps.commentIssue(issue, noPrMergeApprovalComment(state));
        await deps.moveIssue(issue, config.github.doneState);
        await deps.logger.write({
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
        await markMergeFailed(issue, reason, { runId: state.lastRunId });
        return;
      }
      if (!state || !mergePr) {
        const reason = recovered.refusal
          ? `No pull request metadata was found for this issue. AgentOS could not reconstruct it from workspace handoff/validation evidence: ${recovered.refusal.message}`
          : "No pull request metadata was found for this issue.";
        timingStatus = "failed";
        timingLabel = "merge shepherding failed";
        timingMetadata = { reason };
        await markMergeFailed(issue, reason, { runId: state?.lastRunId });
        return;
      }
      if (isRecordedMergeTerminal(state)) {
        timingMetadata = await completeRecordedMergeTerminal({
          issue,
          state,
          mergePr,
          config,
          repoRoot: repoRoot(),
          logger: deps.logger,
          runtimeState: deps.runtimeState,
          retries: deps.retries,
          recordIssueState: deps.recordIssueState,
          commentIssue: (body) => deps.commentIssue(issue, body),
          moveIssue: (targetState) => deps.moveIssue(issue, targetState)
        });
        return;
      }

      await deps.logger.write({
        type: "merge_shepherd_started",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: mergePr,
        payload: { prUrl: mergePr, role: mergeTarget?.role ?? "primary", mergeTarget: config.github.mergeTarget ?? "primary" }
      });

      const github = new GitHubClient(config.github.command);
      try {
        await assertPullRequestUrlMatchesRepo(repoRoot(), mergePr);
        let pr = await github.getPullRequest(mergePr, repoRoot());
        state = await stateStore.merge(issue.identifier, {
          ...state,
          ...landingFreshnessPatch(state, pr, config.github.requireChecks),
          mergeTargetUrl: mergePr,
          mergeTargetRole: mergeTarget?.role ?? "primary",
          updatedAt: new Date().toISOString()
        });
        const branchFreshness = await handleMergeBranchFreshness({ config, github, repoRoot: repoRoot(), issue, state, stateStore, pullRequest: pr, prUrl: mergePr, logger: deps.logger, commentIssue: (body, key) => deps.commentIssue(issue, body, key) });
        state = branchFreshness.state;
        if (branchFreshness.action === "waiting") {
          ({ timingStatus, timingLabel, timingMetadata } = branchFreshness);
          await markMergeWaiting(issue, mergePr, branchFreshness.reason, state.lastRunId);
          return;
        }
        if (branchFreshness.action === "failed") {
          ({ timingStatus, timingLabel, timingMetadata } = branchFreshness);
          await markMergeFailed(issue, branchFreshness.reason, { prUrl: mergePr, runId: state.lastRunId, route: mergeFailureActiveRepairRoute(branchFreshness.reason) });
          return;
        }
        if (pr.merged) {
          const ciWaitFinishedAt = new Date().toISOString();
          await deps.finishOpenRunPhase(state.lastRunId, issue, "ci-wait", "completed", ciWaitFinishedAt, { prUrl: mergePr, result: "already merged" });
          const cleanupWarnings = await cleanupMergedPullRequest({ issue, github, pullRequest: pr, config, repoRoot: deps.repoRoot, logger: deps.logger });
          timingMetadata = { prUrl: mergePr, result: "already merged", cleanupWarnings };
          await deps.recordIssueState(issue, alreadyMergedIssuePatch(state, pr, new Date().toISOString(), "merge shepherd: pull request is already merged", cleanupWarnings));
          await deps.runtimeState.clearIssue(issue.id, issue.identifier);
          deps.retries.delete(issue.id);
          await deps.commentIssue(issue, `### AgentOS merge shepherd\n\nPull request is already merged. Treating that as authoritative and completing the issue.\n\n- PR: ${mergePr}${cleanupWarnings.length ? `\n\nCleanup warnings:\n${cleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`);
          await deps.moveIssue(issue, config.github.doneState);
          return;
        }

        const landingBlock = await mergeShepherdLandingPreflightBlock({ config, preflight: deps.preflight(), runtimeState: deps.runtimeState, state, pullRequest: pr, prUrl: mergePr });
        if (landingBlock) {
          timingStatus = landingBlock.timingStatus;
          timingLabel = landingBlock.timingLabel;
          timingMetadata = landingBlock.timingMetadata;
          if (landingBlock.status === "waiting") await markMergeWaiting(issue, mergePr, landingBlock.reason, state.lastRunId);
          else await markMergeFailed(issue, landingBlock.reason, { prUrl: mergePr, runId: state.lastRunId, route: mergeFailureActiveRepairRoute(landingBlock.reason) });
          return;
        }

        const validationBlockReason = config.review.enabled ? approvedReviewValidationBlockReason(state) : null;
        if (validationBlockReason) {
          timingStatus = "failed";
          timingLabel = "merge shepherding failed";
          timingMetadata = { prUrl: mergePr, reason: validationBlockReason };
          await markMergeFailed(issue, validationBlockReason, { prUrl: mergePr, runId: state.lastRunId });
          return;
        }
        if (config.review.enabled && isReviewSplitRecommendationBlocking(state)) {
          const reason = `split/follow-up recommendation is still open (${state.splitRecommendation?.reason ?? "unknown reason"})`;
          timingStatus = "failed";
          timingLabel = "merge shepherding failed";
          timingMetadata = { prUrl: mergePr, reason };
          await markMergeFailed(issue, reason, { prUrl: mergePr, runId: state.lastRunId, route: "needs-input", reviewGate: true });
          return;
        }
        if (config.review.enabled && state.reviewStatus !== "approved") {
          const supervisorMergeDecision = reviewSupervisorMergeDecision(state);
          if (!supervisorMergeDecision && !config.github.allowHumanMergeOverride) {
            const reason = `automated review is not approved (reviewStatus=${state.reviewStatus ?? "missing"})`;
            timingStatus = "failed";
            timingLabel = "merge shepherding failed";
            timingMetadata = { prUrl: mergePr, reason };
            await markMergeFailed(issue, reason, { prUrl: mergePr, runId: state.lastRunId, route: "needs-input", reviewGate: true });
            return;
          }
          if (!supervisorMergeDecision && !state.humanOverrideAt) {
            const overrideAt = new Date().toISOString();
            await stateStore.merge(issue.identifier, {
              ...state,
              humanOverrideAt: overrideAt,
              humanContinuationAt: overrideAt,
              lifecycleStatus: "human_continuation",
              updatedAt: overrideAt
            });
            await deps.commentIssue(
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
            await deps.logger.write({
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
            await markMergeFailed(issue, reason, { prUrl: mergePr, runId: state.lastRunId });
            return;
          }
        }

        pr = await markDraftPullRequestReadyIfConfigured({ issue, github, repoRoot: repoRoot(), pr, prUrl: mergePr, state, requireChecks: config.github.requireChecks, markDraftReady: config.github.markDraftReady, reason: "merge shepherd landing preflight passed", recordIssueState: deps.recordIssueState, commentIssue: deps.commentIssue, logger: deps.logger });
        const readiness = evaluateMergeReadiness(pr, config.github.requireChecks);
        if (!readiness.ready) {
          if (readiness.reason.includes("pending")) {
            timingStatus = "waiting";
            timingLabel = "merge shepherding waiting on CI";
            timingMetadata = { prUrl: mergePr, reason: readiness.reason };
            await markMergeWaiting(issue, mergePr, readiness.reason, state.lastRunId);
          } else {
            const ciWaitFinishedAt = new Date().toISOString();
            await deps.finishOpenRunPhase(state.lastRunId, issue, "ci-wait", "failed", ciWaitFinishedAt, { prUrl: mergePr, reason: readiness.reason });
            timingStatus = "failed";
            timingLabel = "merge shepherding failed";
            timingMetadata = { prUrl: mergePr, reason: readiness.reason };
            await markMergeFailed(issue, readiness.reason, { prUrl: mergePr, runId: state.lastRunId, route: "running" });
          }
          return;
        }

        const ciWaitFinishedAt = new Date().toISOString();
        await deps.finishOpenRunPhase(state.lastRunId, issue, "ci-wait", "completed", ciWaitFinishedAt, { prUrl: mergePr, reason: "checks ready" });
        await deps.commentIssue(issue, `### AgentOS merge shepherd\n\nChecks are green and the pull request is mergeable. Starting ${config.github.mergeMethod} merge.\n\n- PR: ${mergePr}`);
        await github.mergePullRequest(mergePr, config.github, repoRoot());
        await deps.refreshDaemonRuntimeState({ forceMainRefresh: true });
        const cleanupWarnings = await cleanupMergedPullRequest({ issue, github, pullRequest: pr, config, repoRoot: deps.repoRoot, logger: deps.logger });
        timingMetadata = { prUrl: mergePr, mergeMethod: config.github.mergeMethod, cleanupWarnings };
        await deps.recordIssueState(issue, {
          phase: "completed",
          lifecycleStatus: cleanupWarnings.length ? "post_merge_cleanup_warning" : "merge_success",
          mergeCleanupWarnings: cleanupWarnings.length ? cleanupWarnings : undefined,
          mergedAt: new Date().toISOString(),
          lastError: undefined,
          errorCategory: undefined,
          activeRunId: undefined,
          nextRetryAt: undefined,
          retryAttempt: undefined,
          stopReason: undefined
        });
        await deps.runtimeState.clearIssue(issue.id, issue.identifier);
        await deps.commentIssue(issue, `### AgentOS merge complete\n\nMerged successfully.\n\n- PR: ${mergePr}\n- Method: ${config.github.mergeMethod}${cleanupWarnings.length ? `\n\nCleanup warnings:\n${cleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`);
        await deps.moveIssue(issue, config.github.doneState);
        await deps.logger.write({
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
        await markMergeFailed(issue, reason, { prUrl: mergePr, runId: state.lastRunId, route: mergeFailureActiveRepairRoute(reason) });
      }
    } finally {
      await deps.writePhaseTimingEvent(issue, {
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

  return {
    name: "merge-shepherd",
    processApprovedPullRequestLanding,
    processMergeState
  };
}
