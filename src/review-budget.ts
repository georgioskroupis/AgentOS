import { join } from "node:path";
import { writeTextEnsuringDir } from "./fs-utils.js";
import { latestAuthoritativeHumanDecision } from "./issue-state.js";
import { blockingFindings } from "./review.js";
import type { HumanDecisionState, Issue, IssueState, ReviewBudgetSignal, ReviewBudgetState, ReviewFinding, ReviewSplitRecommendation, ServiceConfig, ValidationState } from "./types.js";

export interface ReviewBudgetEvaluationInput {
  issue: Issue;
  config: ServiceConfig;
  iteration: number;
  reviewStartedAt?: string;
  changedFiles: string[];
  previousFindings: ReviewFinding[];
  currentFindings: ReviewFinding[];
  repeatedFindingHashes: string[];
  reviewTokenTotal: number;
  fixerIterations: number;
  validation?: ValidationState;
  initialReviewStatus?: string | null;
  now?: string;
}

export interface ReviewBudgetEvaluation {
  budget: ReviewBudgetState;
  splitRecommendation: ReviewSplitRecommendation | null;
  shouldRecommendSplit: boolean;
}

export function evaluateReviewBudget(input: ReviewBudgetEvaluationInput): ReviewBudgetEvaluation {
  const config = input.config.review.budget;
  const evaluatedAt = input.now ?? new Date().toISOString();
  if (!config.enabled) {
    return {
      budget: { status: "within_budget", mode: config.mode, evaluatedAt, summary: "Review budget disabled.", signals: [] },
      splitRecommendation: null,
      shouldRecommendSplit: false
    };
  }

  const blocking = blockingFindings(input.currentFindings, input.config);
  const classifications = blocking.map((finding) => classifyFinding(finding, config.broadCategories));
  const hasBroadOrNonMechanicalFinding = classifications.some((classification) => classification !== "mechanical");
  const signals: ReviewBudgetSignal[] = [];
  const changedFileCount = new Set(input.changedFiles).size;
  const elapsedMs = elapsedSince(input.reviewStartedAt, evaluatedAt);
  const p1p2Count = blocking.filter((finding) => finding.severity === "P1" || finding.severity === "P2").length;
  const validationReruns = validationRerunCount(input.validation);

  pushIf(signals, changedFileCount > config.maxChangedFiles, "changed_file_count", "broad", changedFileCount, config.maxChangedFiles, `${changedFileCount} changed file(s) exceed the review budget.`);
  pushIf(signals, elapsedMs > config.maxReviewElapsedMs, "review_elapsed_ms", "broad", elapsedMs, config.maxReviewElapsedMs, `Review/fix elapsed time is ${elapsedMs}ms.`);
  pushIf(signals, input.reviewTokenTotal > config.maxReviewTokens, "review_token_total", "broad", input.reviewTokenTotal, config.maxReviewTokens, `Review/fix token volume is ${input.reviewTokenTotal}.`);
  pushIf(signals, validationReruns > config.maxValidationReruns, "validation_reruns", "broad", validationReruns, config.maxValidationReruns, `${validationReruns} validation rerun(s) recorded.`);
  pushIf(signals, input.iteration >= config.maxReviewIterations, "review_iteration_count", hasBroadOrNonMechanicalFinding ? "broad" : "mechanical", input.iteration, config.maxReviewIterations, `Review iteration ${input.iteration} reached the budget limit.`);
  pushIf(signals, blocking.length > 0 && input.fixerIterations >= config.maxFixerIterations, "fixer_iteration_count", hasBroadOrNonMechanicalFinding ? "broad" : "mechanical", input.fixerIterations, config.maxFixerIterations, `${input.fixerIterations} fixer iteration(s) have already run.`);
  pushIf(signals, blocking.length > config.maxBlockingFindings, "blocking_finding_count", hasBroadOrNonMechanicalFinding ? "broad" : "mechanical", blocking.length, config.maxBlockingFindings, `${blocking.length} blocking finding(s) exceed the budget.`);
  pushIf(signals, p1p2Count > config.maxP1P2Findings, "p1_p2_finding_count", hasBroadOrNonMechanicalFinding ? "broad" : "mechanical", p1p2Count, config.maxP1P2Findings, `${p1p2Count} P1/P2 finding(s) exceed the budget.`);

  const repeatedBroad = repeatedBroadCategories(input.previousFindings, blocking, config.broadCategories, config.repeatedBroadCategoryThreshold);
  if (repeatedBroad.length) {
    signals.push({
      name: "repeated_broad_categories",
      classification: "broad",
      current: repeatedBroad.length,
      threshold: config.repeatedBroadCategoryThreshold,
      summary: `Repeated broad review categories: ${repeatedBroad.join(", ")}.`
    });
  }

  const lateNew = lateNewP1P2Findings(input);
  if (config.lateNewBlockingFindingAfterApproval && lateNew > 0) {
    signals.push({
      name: "late_new_p1_p2_after_approval",
      classification: "broad",
      current: lateNew,
      threshold: 0,
      summary: `${lateNew} new P1/P2 finding(s) appeared after a prior approved state.`
    });
  }

  const status = signals.length ? "exceeded" : "within_budget";
  const budget: ReviewBudgetState = {
    status,
    mode: config.mode,
    evaluatedAt,
    summary: status === "exceeded" ? `${signals.length} review budget signal(s) exceeded.` : "Review budget remains within configured limits.",
    signals
  };
  const splitSignals = signals.filter((signal) => signal.classification !== "mechanical");
  const splitRecommendation = splitSignals.length
    ? {
        recommended: true,
        action: config.mode,
        reason: "review budget exceeded for broad or non-mechanical signals",
        summary: `Recommend split or follow-up work for ${input.issue.identifier}: ${splitSignals.map((signal) => signal.name).join(", ")}.`,
        signals: splitSignals,
        recordedAt: evaluatedAt
      }
    : null;
  return { budget, splitRecommendation, shouldRecommendSplit: Boolean(splitRecommendation) };
}

export async function prepareReviewFollowUpProposal(repoRoot: string, issue: Issue, recommendation: ReviewSplitRecommendation): Promise<ReviewSplitRecommendation> {
  if (recommendation.action !== "prepare-draft") return recommendation;
  const artifactPath = `.agent-os/follow-ups/${safeFileName(issue.identifier)}-review-budget.md`;
  const title = `Split ${issue.identifier}: review budget follow-up`;
  const body = [
    `# ${title}`,
    "",
    `Parent issue: ${issue.identifier}${issue.url ? ` (${issue.url})` : ""}`,
    "",
    recommendation.summary,
    "",
    "Budget signals:",
    ...recommendation.signals.map((signal) => `- ${signal.name}: ${signal.summary}`),
    "",
    "Suggested next issue:",
    "- Isolate the broad architecture, lifecycle, status, or orchestration concern behind the repeated/budgeted review signal.",
    "- Keep the current PR limited to cheap mechanical corrections only if a trusted reviewer accepts that boundary."
  ].join("\n");
  await writeTextEnsuringDir(join(repoRoot, artifactPath), `${body}\n`);
  return { ...recommendation, proposals: [{ title, body, artifactPath }] };
}

export function formatReviewBudgetState(budget: ReviewBudgetState | undefined): string {
  if (!budget) return "Review budget: none recorded";
  const lines = [`Review budget: ${budget.status} (${budget.mode})`, `Review budget summary: ${budget.summary}`];
  if (budget.signals.length) lines.push("Review budget signals:", ...budget.signals.map((signal) => `- ${signal.name}: ${signal.summary}`));
  return lines.join("\n");
}

export function formatSplitRecommendation(recommendation: ReviewSplitRecommendation | undefined): string {
  if (!recommendation?.recommended) return "Split recommendation: none recorded";
  const lines = [`Split recommendation: ${recommendation.action}`, `Split reason: ${recommendation.reason}`, `Split summary: ${recommendation.summary}`];
  if (recommendation.proposals?.length) lines.push("Follow-up proposals:", ...recommendation.proposals.map((proposal) => `- ${proposal.title}${proposal.artifactPath ? ` (${proposal.artifactPath})` : ""}`));
  return lines.join("\n");
}

export function reviewSupervisorMergeDecision(state: Pick<IssueState, "humanDecisions" | "lastHumanDecision"> | null | undefined): HumanDecisionState | null {
  const decision = latestAuthoritativeHumanDecision([
    ...(state?.humanDecisions ?? []),
    ...(state?.lastHumanDecision ? [state.lastHumanDecision] : [])
  ]);
  if (!decision) return null;
  return ["approve_as_is", "accept_risk", "split_follow_up", "proceed_to_merge_after_supervisor_fix"].includes(decision.type) ? decision : null;
}

export function isReviewSplitRecommendationOpen(state: Pick<IssueState, "splitRecommendation" | "humanDecisions" | "lastHumanDecision"> | null | undefined): boolean {
  const recommendation = state?.splitRecommendation;
  if (!recommendation?.recommended) return false;
  const decision = reviewSupervisorMergeDecision(state);
  return !decision || !decisionClosesSplitRecommendation(decision, recommendation);
}

function decisionClosesSplitRecommendation(decision: HumanDecisionState, recommendation: ReviewSplitRecommendation): boolean {
  const decidedAt = Date.parse(decision.decidedAt);
  const recordedAt = Date.parse(recommendation.recordedAt);
  if (!Number.isFinite(decidedAt) || !Number.isFinite(recordedAt)) return false;
  return decidedAt > recordedAt;
}

function pushIf(signals: ReviewBudgetSignal[], condition: boolean, name: string, classification: ReviewBudgetSignal["classification"], current: number, threshold: number, summary: string): void {
  if (!condition) return;
  signals.push({ name, classification, current, threshold, summary });
}

function elapsedSince(startedAt: string | undefined, now: string): number {
  const start = Date.parse(startedAt ?? now);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

function classifyFinding(finding: ReviewFinding, broadCategories: string[]): ReviewBudgetSignal["classification"] {
  if (broadCategoryForFinding(finding, broadCategories)) return "broad";
  if (finding.decision === "human_required") return "non_mechanical";
  if (finding.reviewer === "checks") return "mechanical";
  if (finding.file && finding.line && finding.reviewer !== "architecture") return "mechanical";
  return "non_mechanical";
}

function repeatedBroadCategories(previous: ReviewFinding[], current: ReviewFinding[], broadCategories: string[], threshold: number): string[] {
  if (threshold <= 0) return [];
  const counts = new Map<string, number>();
  for (const finding of [...blockingBroad(previous, broadCategories), ...blockingBroad(current, broadCategories)]) {
    counts.set(finding, (counts.get(finding) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count >= threshold).map(([category]) => category);
}

function blockingBroad(findings: ReviewFinding[], broadCategories: string[]): string[] {
  return findings
    .filter((finding) => finding.severity === "P0" || finding.severity === "P1" || finding.severity === "P2")
    .map((finding) => broadCategoryForFinding(finding, broadCategories))
    .filter((category): category is string => Boolean(category));
}

function broadCategoryForFinding(finding: ReviewFinding, broadCategories: string[]): string | null {
  const text = `${finding.reviewer} ${finding.body}`.toLowerCase();
  return broadCategories.find((category) => text.includes(category.toLowerCase())) ?? null;
}

function lateNewP1P2Findings(input: ReviewBudgetEvaluationInput): number {
  if (input.initialReviewStatus !== "approved") return 0;
  const previous = new Set([...input.previousFindings.map((finding) => finding.findingHash), ...input.repeatedFindingHashes]);
  return input.currentFindings.filter((finding) => (finding.severity === "P1" || finding.severity === "P2") && !previous.has(finding.findingHash)).length;
}

function validationRerunCount(validation: ValidationState | undefined): number {
  if (!validation) return 0;
  const accepted = validation.acceptedCommands?.length ?? 0;
  const additionalPassing = validation.additionalPassingCommands?.length ?? 0;
  const failed = validation.failedHistoricalAttempts?.length ?? 0;
  return Math.max(0, accepted + additionalPassing + failed - 1);
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
