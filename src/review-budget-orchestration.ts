import { formatReviewBudgetState, formatSplitRecommendation } from "./review-budget.js";
import type { IssueState, ReviewBudgetState, ReviewRunnerFailure, ReviewSplitRecommendation, ReviewStateReviewer, ReviewStatus } from "./types.js";

export function reviewIterationLogMessage(iteration: number, status: ReviewStatus, shouldRecommendSplit: boolean): string {
  const result = status === "approved" && shouldRecommendSplit ? "approved_with_budget_advisory" : shouldRecommendSplit ? "budget_exceeded" : status;
  return `iteration ${iteration}: ${result}`;
}

export function formatApprovedReviewComment(input: {
  reviewTargetList: string;
  iteration: number;
  reviewers: ReviewStateReviewer[];
  budget: ReviewBudgetState;
  splitRecommendation?: ReviewSplitRecommendation | null;
  reportOnlyCheckDiagnostics?: string | null;
}): string {
  const splitRecommendation = input.splitRecommendation;
  const reportOnlyCheckDiagnostics = input.reportOnlyCheckDiagnostics?.trim() || null;
  return [
    "### AgentOS automated review approved",
    "",
    "Required Wiggum reviewers approved this PR.",
    "",
    input.reviewTargetList,
    `- Iteration: ${input.iteration}`,
    `- Reviewers: ${input.reviewers.map((reviewer) => `${reviewer.name}=${reviewer.decision}`).join(", ")}`,
    reportOnlyCheckDiagnostics ? "" : null,
    reportOnlyCheckDiagnostics ? "Report-only check diagnostics:" : null,
    reportOnlyCheckDiagnostics ? "These diagnostics are operator-visible only. AgentOS did not retry checks, update branches, mark PRs ready, or merge from this classification." : null,
    reportOnlyCheckDiagnostics,
    splitRecommendation ? "" : null,
    splitRecommendation ? "Review budget advisory:" : null,
    splitRecommendation ? formatReviewBudgetState(input.budget) : null,
    splitRecommendation ? "" : null,
    splitRecommendation ? formatSplitRecommendation(splitRecommendation, { advisory: true }) : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatReviewFixRequestedComment(input: {
  reviewTargetList: string;
  iteration: number;
  blockingFindingsText: string;
  budget: ReviewBudgetState;
  splitRecommendation?: ReviewSplitRecommendation | null;
  advisorySplitRecommendation: boolean;
}): string {
  const splitRecommendation = input.advisorySplitRecommendation ? input.splitRecommendation : null;
  return [
    "### AgentOS automated review requested fixes",
    "",
    "Blocking findings were found. AgentOS is running a focused fix turn on the existing PR.",
    "",
    input.reviewTargetList,
    `- Iteration: ${input.iteration}`,
    "",
    input.blockingFindingsText,
    splitRecommendation ? "" : null,
    splitRecommendation ? "Review budget advisory:" : null,
    splitRecommendation ? formatReviewBudgetState(input.budget) : null,
    splitRecommendation ? "" : null,
    splitRecommendation ? formatSplitRecommendation(splitRecommendation, { advisory: true }) : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatReviewSplitRecommendedComment(input: {
  reviewTargetList: string;
  iteration: number;
  budget: ReviewBudgetState;
  splitRecommendation: ReviewSplitRecommendation;
}): string {
  return [
    "### AgentOS review budget recommends split/follow-up",
    "",
    "The Wiggum loop stopped because the configured review budget was exceeded for broad or non-mechanical signals.",
    "",
    input.reviewTargetList,
    `- Iteration: ${input.iteration}`,
    "",
    formatReviewBudgetState(input.budget),
    "",
    formatSplitRecommendation(input.splitRecommendation)
  ].join("\n");
}

export function formatReviewHumanRequiredComment(input: {
  reason: string;
  reviewTargetList: string;
  iteration: number;
  reviewRunnerFailuresText: string;
  blockingFindingsText: string;
}): string {
  return [
    "### AgentOS automated review needs human judgment",
    "",
    `The Wiggum loop stopped because ${input.reason}.`,
    "",
    input.reviewTargetList,
    `- Iteration: ${input.iteration}`,
    "",
    "Reviewer runner failures:",
    input.reviewRunnerFailuresText,
    "",
    "Blocking findings:",
    input.blockingFindingsText
  ].join("\n");
}

export function reviewHumanRequiredReason(input: {
  terminalReviewerFailure?: ReviewRunnerFailure | null;
  humanRequired: boolean;
  repeatedFindingHashes: string[];
  hardReviewBudgetStop: boolean;
}): string {
  if (input.terminalReviewerFailure) {
    return input.terminalReviewerFailure.classification === "mechanical" && input.terminalReviewerFailure.exhausted
      ? "a reviewer runner failed to produce a trusted artifact after its retry budget was exhausted"
      : "a reviewer runner failure requires human judgment";
  }
  if (input.humanRequired) return "a reviewer requested human judgment";
  if (input.repeatedFindingHashes.length > 0) return "the same blocking finding repeated after a fix";
  if (input.hardReviewBudgetStop) return "the configured review budget hard stop was reached";
  return "maximum review iterations reached";
}

export function approvedReviewValidationBlockReason(state: IssueState): string | null {
  if (state.reviewStatus !== "approved") return null;
  if (!state.validation) return "approved automated review is missing validation evidence before merge progression";
  if (state.validation.status === "passed") return null;
  const final = state.validation.finalStatus ? `, final=${state.validation.finalStatus}` : "";
  const errors = state.validation.errors?.length ? `: ${state.validation.errors.join("; ")}` : "";
  return `approved automated review validation evidence is not passing (status=${state.validation.status}${final})${errors}`;
}
