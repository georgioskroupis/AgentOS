import { join, resolve } from "node:path";
import { contextBudgetExceededMessage } from "./context-budget.js";
import { buildTargetedContextPack } from "./context-pack.js";
import { readGitHubReviewContext } from "./github-context.js";
import { assertPullRequestUrlsMatchRepo } from "./github-repository.js";
import { extractPullRequestUrls, issueStateFromHandoff, IssueStateStore, pullRequestUrls, reviewTargetPullRequests } from "./issue-state.js";
import { JsonlLogger } from "./logging.js";
import { reviewIterationFinishedMonitorEvent, reviewIterationStartedMonitorEvent, writeModelFinishedMonitorEvent, writeTurnCompletedMonitorEvent, writeTurnStartedMonitorEvent, writeValidationCommandMonitorEvents } from "./orchestrator-monitor-events.js";
import { formatPullRequestTargets, formatRecordedPullRequests, handoffPullRequestValidationFinding, joinedHeadShas, reviewCheckFindings, reviewTargetSelectionError } from "./orchestrator-review-helpers.js";
import { requestFlakyCiRetriesIfEligible } from "./orchestrator-ci-retry.js";
import { readHandoff } from "./orchestrator-state-helpers.js";
import { verifyHandoffValidationEvidence } from "./orchestrator-validation.js";
import type { PostValidationExtension, PostValidationExtensionInput } from "./post-validation-extension.js";
import { timingStatusForRunResult } from "./phase-timing.js";
import { blockingFindings, ensureReviewIterationDir, fixPrompt, formatFindings, formatReviewRunnerFailures, repeatedBlockingHashes } from "./review.js";
import { evaluateReviewBudget, prepareReviewFollowUpProposal, reviewBudgetContinuation } from "./review-budget.js";
import { formatApprovedReviewComment, formatReviewFixRequestedComment, formatReviewHumanRequiredComment, formatReviewSplitRecommendedComment, reviewHumanRequiredReason, reviewIterationLogMessage } from "./review-budget-orchestration.js";
import { reviewerConcurrencyFor, runReviewerIteration } from "./reviewer-scheduler.js";
import { validationEvidenceFinding } from "./validation.js";
import type { AgentEvent, AgentRunner, ContextBudgetState, ContextBudgetTurnKind, Issue, IssueState, ReviewRunnerFailure, ReviewStatus, ReviewTargetMode, ServiceConfig, Workspace } from "./types.js";
import type { RunPhaseTiming, RunTimingStatus } from "./runs.js";

type IssueStateOrNull = Awaited<ReturnType<PostValidationExtension["afterValidation"]>>;
type LegacyReviewRunner = (input: PostValidationExtensionInput) => Promise<IssueStateOrNull>;
type RunEventWriter = (runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }) => Promise<void>;

export interface ReviewFixerCiPostValidationExtensionDeps {
  repoRoot: string;
  config: () => ServiceConfig;
  runner: () => AgentRunner;
  logger: JsonlLogger;
  recordIssueState(issue: Issue, patch: Partial<IssueState>): Promise<IssueState>;
  commentIssue(issue: Issue, body: string): Promise<void>;
  startRunPhase(runId: string, issue: Issue, phase: "automated-review" | "fixer-turn", label?: string, metadata?: Record<string, unknown>): Promise<RunPhaseTiming>;
  finishRunPhase(runId: string, issue: Issue, timing: RunPhaseTiming, status?: Exclude<RunTimingStatus, "running">, metadata?: Record<string, unknown>): Promise<void>;
  recordContextBudget(issue: Issue, runId: string | null | undefined, kind: ContextBudgetTurnKind, prompt: string): Promise<ContextBudgetState>;
  writeRunEvent: RunEventWriter;
  markRunningActivity(issueId: string, timestamp: string): void;
}

export function createReviewFixerCiPostValidationExtension(
  depsOrRunReviewFixerCiRepair: ReviewFixerCiPostValidationExtensionDeps | LegacyReviewRunner
): PostValidationExtension {
  if (typeof depsOrRunReviewFixerCiRepair === "function") {
    return {
      name: "review-fixer-ci-repair",
      afterValidation: depsOrRunReviewFixerCiRepair
    };
  }
  return {
    name: "review-fixer-ci-repair",
    afterValidation: (input) => runReviewFixerCiRepair(depsOrRunReviewFixerCiRepair, input)
  };
}

export async function runReviewFixerCiRepair(
  deps: ReviewFixerCiPostValidationExtensionDeps,
  input: PostValidationExtensionInput
): Promise<IssueState | null> {
  const config = deps.config();
  const { issue, workspace, state, attempt, signal, runId } = input;
  if (!config.review.enabled) return state;
  const reviewTargetMode = config.review.targetMode ?? "merge-eligible";
  if (!state || state.outcome === "already_satisfied") return state;
  let latestState: IssueState | null = state;
  const initialReviewTargets = reviewTargetPullRequests(state, reviewTargetMode);
  if (initialReviewTargets.length === 0 && pullRequestUrls(state).length === 0) return latestState;
  const reviewTiming = runId ? await deps.startRunPhase(runId, issue, "automated-review", "automated review", { reviewTargetMode }) : null;
  const finishReviewTiming = async (unwoundByError: boolean): Promise<void> => {
    if (!runId || !reviewTiming) return;
    const reviewStatus = latestState?.reviewStatus;
    await deps.finishRunPhase(runId, issue, reviewTiming, reviewStatus === "approved" || (reviewStatus === "pending" && !unwoundByError) ? "completed" : "failed", {
      reviewStatus,
      reviewIteration: latestState?.reviewIteration,
      reviewTargetMode,
      ...(unwoundByError ? { reviewExit: "error" } : {})
    });
  };
  let reviewUnwoundByError = false;
  try {
    if (initialReviewTargets.length === 0) {
      latestState = await recordReviewTargetSelectionFailure(deps, issue, state, reviewTargetMode);
      return latestState;
    }
    const initialReviewTargetUrls = initialReviewTargets.map((target) => target.url);
    const initialReviewTargetList = formatPullRequestTargets(initialReviewTargets);

    await deps.commentIssue(
      issue,
      [
        "### AgentOS automated review started",
        "",
        "The Ralph Wiggum loop is reviewing the selected PR target(s) before the post-validation extension completes.",
        "",
        `- Review target mode: ${reviewTargetMode}`,
        initialReviewTargetList,
        `- Required reviewers: ${config.review.requiredReviewers.join(", ")}`,
        `- Reviewer concurrency: ${config.review.parallelReviewers ? `up to ${config.review.maxConcurrentReviewers}` : "sequential"}`,
        `- Max iterations: ${config.review.maxIterations}`
      ].join("\n")
    );

    const repoRoot = resolve(deps.repoRoot);
    let previousFindings = state.findings ?? [];
    let reviewRunnerFailures: ReviewRunnerFailure[] = [];
    let reviewTokenTotal = 0;
    const initialReviewStatus = state.reviewStatus ?? null;
    latestState = await deps.recordIssueState(issue, {
      phase: "review",
      reviewStatus: "pending",
      reviewIteration: state.reviewIteration ?? 0,
      reviewTargetMode,
      reviewTargetUrls: initialReviewTargetUrls,
      reviewRunnerFailures: []
    });
    for (let iteration = (state.reviewIteration ?? 0) + 1; iteration <= config.review.maxIterations; iteration += 1) {
      const reviewTargets = reviewTargetPullRequests(latestState, reviewTargetMode);
      if (reviewTargets.length === 0) {
        latestState = pullRequestUrls(latestState).length > 0 ? await recordReviewTargetSelectionFailure(deps, issue, latestState, reviewTargetMode) : latestState;
        return latestState;
      }
      const reviewPr = reviewTargets[0].url;
      const reviewTargetUrls = reviewTargets.map((target) => target.url);
      const reviewTargetList = formatPullRequestTargets(reviewTargets);
      await ensureReviewIterationDir(workspace.path, issue.identifier, iteration);
      const githubContext = await readGitHubReviewContext(reviewTargets, { githubCommand: config.github.command, repoRoot: deps.repoRoot }).catch(async (error: Error) => {
        latestState = await deps.recordIssueState(issue, {
          phase: "review",
          reviewStatus: "human_required",
          lastError: error.message,
          errorCategory: "review",
          reviewTargetMode,
          reviewTargetUrls
        });
        await deps.commentIssue(issue, `### AgentOS automated review needs human judgment\n\nAgentOS could not read the selected pull request target(s) for review.\n\n${reviewTargetList}\n- Error: ${error.message}`);
        await deps.logger.write({
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
        latestState = await deps.recordIssueState(issue, {
          phase: "review",
          reviewStatus: "human_required",
          lastError: `pull request is ${nonOpen.status.state}`,
          errorCategory: "review",
          reviewTargetMode,
          reviewTargetUrls
        });
        await deps.commentIssue(issue, `### AgentOS automated review needs human judgment\n\nSelected pull request target is not open.\n\n- PR: ${nonOpen.target.url}\n- State: ${nonOpen.status.state}`);
        return latestState;
      }
      const flakyRetry = await requestFlakyCiRetriesIfEligible({
        issue,
        state: latestState,
        entries: githubContext.entries,
        reviewTargetMode,
        runId,
        config,
        repoRoot: deps.repoRoot,
        logger: deps.logger,
        recordIssueState: (patch) => deps.recordIssueState(issue, patch),
        commentIssue: (body) => deps.commentIssue(issue, body)
      });
      if (flakyRetry.requested || flakyRetry.terminalState) {
        latestState = flakyRetry.state;
        return latestState;
      }
      const flakyRetryFindings = flakyRetry.findings;
      const reviewers = reviewersFor(config, [...new Set(githubContext.entries.flatMap((entry) => entry.status.changedFiles))]);
      const reviewerConcurrency = reviewerConcurrencyFor(config, reviewers.length);
      const parallelReviewers = reviewerConcurrency > 1;

      const reviewIterationEvent = reviewIterationStartedMonitorEvent({ runId, issue, iteration, maxIterations: config.review.maxIterations, prUrls: reviewTargetUrls, reviewers, reviewerConcurrency, parallelReviewers });
      if (runId) await deps.writeRunEvent(runId, reviewIterationEvent);
      else await deps.logger.write(reviewIterationEvent);

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
        config,
        runner: deps.runner(),
        logger: deps.logger,
        onActivity: (issueId, timestamp) => deps.markRunningActivity(issueId, timestamp),
        writeRunEvent: deps.writeRunEvent
      });
      reviewRunnerFailures = [...reviewRunnerFailures, ...reviewerResult.reviewRunnerFailures];
      reviewTokenTotal += reviewerResult.tokenTotal;
      const artifacts = reviewerResult.artifacts;
      const terminalReviewerFailure = reviewerResult.terminalReviewerFailure;
      const reviewerStates = reviewerResult.reviewerStates;

      const validationFinding = validationEvidenceFinding(latestState?.validation);
      const findings = [
        ...artifacts.flatMap((entry) => entry.artifact.findings),
        ...githubContext.entries.flatMap((entry) => reviewCheckFindings(entry.status, config, entry.checkDiagnostics)),
        ...flakyRetryFindings,
        ...(validationFinding ? [validationFinding] : [])
      ];
      for (const finding of findings.filter((finding) => finding.reviewer === "checks")) {
        await deps.logger.write({
          type: "review_finding",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: finding.body,
          payload: finding
        });
      }
      const blocking = blockingFindings(findings, config);
      const currentBlockingHashes = new Set(blocking.map((finding) => finding.findingHash));
      const resolvedFindingHashes = [
        ...(latestState?.resolvedFindingHashes ?? []),
        ...blockingFindings(previousFindings, config)
          .map((finding) => finding.findingHash)
          .filter((hash) => !currentBlockingHashes.has(hash))
      ];
      const humanRequired =
        Boolean(terminalReviewerFailure) ||
        artifacts.some((entry) => entry.artifact.decision === "human_required") ||
        findings.some((finding) => finding.decision === "human_required");
      const allRequiredApproved = config.review.requiredReviewers.every((reviewer) =>
        artifacts.some((entry) => entry.artifact.reviewer === reviewer && entry.artifact.decision === "approved")
      );
      const repeated = repeatedBlockingHashes(previousFindings, findings, config);
      const status: ReviewStatus = humanRequired ? "human_required" : blocking.length > 0 || !allRequiredApproved ? "changes_requested" : "approved";
      const budgetDecision = evaluateReviewBudget({
        issue,
        config,
        iteration,
        reviewStartedAt: reviewTiming?.startedAt,
        changedFiles: githubContext.entries.flatMap((entry) => entry.status.changedFiles),
        previousFindings,
        currentFindings: findings,
        repeatedFindingHashes: repeated,
        reviewTokenTotal,
        fixerIterations: iteration - 1,
        validation: latestState?.validation,
        initialReviewStatus
      });

      latestState = await deps.recordIssueState(issue, {
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
        reviewRunnerFailures,
        reviewBudget: budgetDecision.budget,
        splitRecommendation: budgetDecision.splitRecommendation ?? undefined,
        ...(reviewerResult.contextBudget ? { contextBudget: reviewerResult.contextBudget } : {})
      });

      const reviewCompleteEvent = reviewIterationFinishedMonitorEvent({ runId, issue, iteration, maxIterations: config.review.maxIterations, status, message: reviewIterationLogMessage(iteration, status, budgetDecision.shouldRecommendSplit), blocking: blocking.length, repeated });
      if (runId) await deps.writeRunEvent(runId, reviewCompleteEvent);
      else await deps.logger.write(reviewCompleteEvent);

      if (status === "approved") {
        let advisorySplitRecommendation = budgetDecision.splitRecommendation;
        const reportOnlyCheckFindings = findings.filter((finding) => finding.reviewer === "checks" && finding.findingHash.startsWith("checks-failing-report-only-"));
        const reportOnlyCheckDiagnostics = reportOnlyCheckFindings.length > 0 ? formatFindings(reportOnlyCheckFindings, resolve(deps.repoRoot), { includeLogExcerpts: false }) : null;
        if (budgetDecision.shouldRecommendSplit && budgetDecision.splitRecommendation) {
          advisorySplitRecommendation = await prepareReviewFollowUpProposal(repoRoot, issue, budgetDecision.splitRecommendation);
          latestState = await deps.recordIssueState(issue, { phase: "review", reviewStatus: "approved", reviewBudget: budgetDecision.budget, splitRecommendation: advisorySplitRecommendation, findings, reviewRunnerFailures });
          await deps.logger.write({
            type: "review_split_recommended",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message: `advisory: ${advisorySplitRecommendation.reason}`,
            payload: { splitRecommendation: advisorySplitRecommendation, reviewBudget: budgetDecision.budget, prUrls: reviewTargetUrls, advisory: true }
          });
        }
        await deps.commentIssue(
          issue,
          formatApprovedReviewComment({ reviewTargetList, iteration, reviewers: reviewerStates, budget: budgetDecision.budget, splitRecommendation: advisorySplitRecommendation, reportOnlyCheckDiagnostics })
        );
        return latestState;
      }

      const { advisoryMechanicalSplitRecommendation, hardReviewBudgetStop } = reviewBudgetContinuation({ budgetDecision, blockingFindings: blocking, config, humanRequired, repeatedFindingHashes: repeated, iteration });

      if (budgetDecision.shouldRecommendSplit && budgetDecision.splitRecommendation && !advisoryMechanicalSplitRecommendation) {
        const splitRecommendation = await prepareReviewFollowUpProposal(repoRoot, issue, budgetDecision.splitRecommendation);
        latestState = await deps.recordIssueState(issue, { phase: "review", reviewStatus: "human_required", reviewBudget: budgetDecision.budget, splitRecommendation, findings, reviewRunnerFailures });
        await deps.commentIssue(issue, formatReviewSplitRecommendedComment({ reviewTargetList, iteration, budget: budgetDecision.budget, splitRecommendation }));
        await deps.logger.write({ type: "review_split_recommended", issueId: issue.id, issueIdentifier: issue.identifier, message: splitRecommendation.reason, payload: { splitRecommendation, reviewBudget: budgetDecision.budget, prUrls: reviewTargetUrls } });
        return latestState;
      }

      if (advisoryMechanicalSplitRecommendation && budgetDecision.splitRecommendation) {
        await deps.logger.write({
          type: "review_split_recommended",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: `advisory: ${budgetDecision.splitRecommendation.reason}`,
          payload: { splitRecommendation: budgetDecision.splitRecommendation, reviewBudget: budgetDecision.budget, prUrls: reviewTargetUrls, advisory: true }
        });
      }

      if (humanRequired || repeated.length > 0 || iteration >= config.review.maxIterations || hardReviewBudgetStop) {
        const reason = reviewHumanRequiredReason({ terminalReviewerFailure, humanRequired, repeatedFindingHashes: repeated, hardReviewBudgetStop });
        latestState = await deps.recordIssueState(issue, { phase: "review", reviewStatus: "human_required", findings, reviewRunnerFailures });
        await deps.commentIssue(
          issue,
          formatReviewHumanRequiredComment({
            reason,
            reviewTargetList,
            iteration,
            reviewRunnerFailuresText: formatReviewRunnerFailures(reviewRunnerFailures),
            blockingFindingsText: formatFindings(blocking, resolve(deps.repoRoot), { includeLogExcerpts: false })
          })
        );
        await deps.logger.write({
          type: "review_human_required",
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          message: reason,
          payload: { findings: blocking, repeated, prUrls: reviewTargetUrls, reviewRunnerFailures }
        });
        return latestState;
      }
      await deps.logger.write({
        type: "review_fix_started",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `iteration ${iteration}`,
        payload: { findings: blocking }
      });
      await deps.commentIssue(
        issue,
        formatReviewFixRequestedComment({
          reviewTargetList,
          iteration,
          blockingFindingsText: formatFindings(blocking, resolve(deps.repoRoot), { includeLogExcerpts: false }),
          budget: budgetDecision.budget,
          splitRecommendation: budgetDecision.splitRecommendation,
          advisorySplitRecommendation: advisoryMechanicalSplitRecommendation
        })
      );
      await deps.recordIssueState(issue, { phase: "fix", reviewStatus: "changes_requested" });
      const fixTiming = runId ? await deps.startRunPhase(runId, issue, "fixer-turn", `fixer turn ${iteration}`, { iteration, blockingFindings: blocking.length }) : null;
      let fixContextKind: "ci-repair" | "fixer" = "fixer";
      let fixResult;
      try {
        fixContextKind = blocking.some((finding) => finding.reviewer === "checks") ? "ci-repair" : "fixer";
        const fixerPrompt = fixPrompt({
          issue,
          prUrl: reviewPr,
          reviewTargets: reviewTargetUrls,
          iteration,
          findings: blocking,
          handoffPath: join(workspace.path, ".agent-os", `handoff-${issue.identifier}.md`),
          feedbackSummary: githubContext.feedback,
          contextPack: buildTargetedContextPack({ kind: fixContextKind, issue, state: latestState, pullRequests: githubContext.entries, findings: blocking, validation: latestState?.validation, feedback: githubContext.feedback, artifactRefs: [join(workspace.path, ".agent-os", `handoff-${issue.identifier}.md`)], runId, iteration })
        });
        const fixerBudget = await deps.recordContextBudget(issue, runId, "fixer", fixerPrompt);
        if (fixerBudget.status === "exceeded") {
          latestState = await deps.recordIssueState(issue, {
            phase: "fix",
            reviewStatus: "human_required",
            contextBudget: fixerBudget,
            lastError: contextBudgetExceededMessage(fixerBudget),
            errorCategory: "fix"
          });
          await deps.commentIssue(issue, `### AgentOS review fix needs human judgment\n\nThe focused fixer prompt exceeded the configured context budget.\n\n- PR: ${reviewPr}\n- ${fixerBudget.summary}`);
          if (runId && fixTiming) await deps.finishRunPhase(runId, issue, fixTiming, "failed", { iteration, reason: "context_budget_exceeded" });
          return latestState;
        }
        if (runId && fixTiming) await writeTurnStartedMonitorEvent({ writeRunEvent: deps.writeRunEvent, runId, issue, timing: fixTiming, label: `fixer turn ${iteration}`, current: iteration, max: config.review.maxIterations });
        fixResult = await deps.runner().run({
          issue,
          prompt: fixerPrompt,
          attempt,
          workspace,
          config,
          modelRouting: { role: fixContextKind === "ci-repair" ? "ci-repair" : "fixer", attempt: iteration, risk: blocking.map((finding) => finding.reviewer) },
          signal,
          onEvent: (event) => {
            deps.markRunningActivity(issue.id, event.timestamp);
            void deps.logger.write({ ...event, type: `review_fix_${event.type}` });
          }
        });
      } catch (error) {
        if (runId && fixTiming) await deps.finishRunPhase(runId, issue, fixTiming, "failed", { iteration, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      if (runId) await writeModelFinishedMonitorEvent({ writeRunEvent: deps.writeRunEvent, runId, issue, result: fixResult, role: fixContextKind, attempt: iteration });
      if (runId && fixTiming) await writeTurnCompletedMonitorEvent({ writeRunEvent: deps.writeRunEvent, runId, issue, timing: fixTiming, label: `fixer turn ${iteration}`, current: iteration, result: fixResult, max: config.review.maxIterations });
      if (runId && fixTiming) await deps.finishRunPhase(runId, issue, fixTiming, timingStatusForRunResult(fixResult), { iteration, resultStatus: fixResult.status });
      reviewTokenTotal += fixResult.totalTokens ?? 0;
      if (fixResult.status !== "succeeded") {
        latestState = await deps.recordIssueState(issue, {
          phase: "fix",
          reviewStatus: "human_required",
          lastError: fixResult.error ?? fixResult.status,
          errorCategory: "fix"
        });
        await deps.commentIssue(issue, `### AgentOS review fix failed\n\nThe fixer turn did not complete successfully.\n\n- PR: ${reviewPr}\n- Error: ${fixResult.error ?? fixResult.status}`);
        return latestState;
      }
      const updatedHandoff = await readHandoff(workspace.path, issue.identifier);
      if (updatedHandoff) {
        const handoffPrUrls = extractPullRequestUrls(updatedHandoff);
        try {
          await assertPullRequestUrlsMatchRepo(resolve(deps.repoRoot), handoffPrUrls);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const finding = handoffPullRequestValidationFinding(message);
          latestState = await deps.recordIssueState(issue, {
            phase: "review",
            reviewStatus: "human_required",
            lastError: message,
            errorCategory: "review",
            findings: [finding]
          });
          await deps.commentIssue(
            issue,
            [
              "### AgentOS automated review needs human judgment",
              "",
              "The focused fixer handoff contained pull request metadata that AgentOS could not validate against the current repository.",
              "",
              `- Error: ${message}`,
              "",
              "Blocking findings:",
              formatFindings([finding], resolve(deps.repoRoot), { includeLogExcerpts: false })
            ].join("\n")
          );
          await deps.logger.write({
            type: "review_human_required",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            message,
            payload: { findings: [finding], prUrls: handoffPrUrls }
          });
          return latestState;
        }
        const validation = await verifyHandoffValidationEvidence({ config, issue, handoff: updatedHandoff, workspacePath: workspace.path, runId, selectedHeadSha: joinedHeadShas(githubContext.entries) });
        if (runId) await writeValidationCommandMonitorEvents({ writeRunEvent: deps.writeRunEvent, runId, issue, validation });
        const updated = issueStateFromHandoff(issue, updatedHandoff);
        const fixPatch = { phase: "fix" as const, reviewIteration: iteration, lastFixedSha: joinedHeadShas(githubContext.entries), reviewTargetMode, validation: validation.state };
        if (updated) {
          latestState = await new IssueStateStore(resolve(deps.repoRoot)).merge(issue.identifier, { ...updated, ...fixPatch });
        } else {
          latestState = await deps.recordIssueState(issue, fixPatch);
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

async function recordReviewTargetSelectionFailure(
  deps: ReviewFixerCiPostValidationExtensionDeps,
  issue: Issue,
  state: IssueState,
  reviewTargetMode: ReviewTargetMode
): Promise<IssueState> {
  const recordedPrUrls = pullRequestUrls(state);
  const error = reviewTargetSelectionError(state, reviewTargetMode);
  const latestState = await deps.recordIssueState(issue, {
    phase: "review",
    reviewStatus: "human_required",
    lastError: error,
    errorCategory: "review",
    reviewTargetMode,
    reviewTargetUrls: []
  });
  await deps.commentIssue(
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
  await deps.logger.write({
    type: "review_human_required",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    message: error,
    payload: { prUrls: recordedPrUrls, reviewTargetMode }
  });
  return latestState;
}

function reviewersFor(config: ServiceConfig, changedFiles: string[]): string[] {
  const reviewers = [...config.review.requiredReviewers];
  const securityNeeded = changedFiles.some((file) => /(^|\/)(auth|security|secrets?|config|env|api|github|linear|runner|orchestrator)/i.test(file));
  for (const reviewer of config.review.optionalReviewers) {
    if (reviewer === "security" && !securityNeeded) continue;
    if (!reviewers.includes(reviewer)) reviewers.push(reviewer);
  }
  return reviewers;
}
