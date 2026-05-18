import { formatReviewBudgetState, formatSplitRecommendation } from "./review-budget.js";
import type { IssueState, ReviewBudgetState, ReviewSplitRecommendation, ReviewStateReviewer, ReviewStatus } from "./types.js";

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

export function approvedReviewValidationBlockReason(state: IssueState): string | null {
  if (state.reviewStatus !== "approved") return null;
  if (!state.validation) return "approved automated review is missing validation evidence before merge progression";
  if (state.validation.status === "passed") return null;
  const final = state.validation.finalStatus ? `, final=${state.validation.finalStatus}` : "";
  const errors = state.validation.errors?.length ? `: ${state.validation.errors.join("; ")}` : "";
  return `approved automated review validation evidence is not passing (status=${state.validation.status}${final})${errors}`;
}
