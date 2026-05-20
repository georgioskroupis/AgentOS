import { isAuthoritativeHumanDecision } from "./issue-state.js";
import { isReviewSplitRecommendationBlocking, reviewSupervisorMergeDecision } from "./review-budget.js";
import type { HumanDecisionState, Issue, IssueComment, IssueState } from "./types.js";

export const RECENT_LINEAR_COMMENT_LIMIT = 20;
export const GUARDRAIL_LINEAR_COMMENT_LIMIT = Number.MAX_SAFE_INTEGER;

export function allowsImplementationContinuation(state: IssueState | null, decision: HumanDecisionState | null): boolean {
  if (decision?.type !== "fix_findings") return false;
  if (!state) return false;
  if (state.reviewStatus === "approved") return false;
  return (
    state.reviewStatus === "human_required" ||
    state.reviewStatus === "changes_requested" ||
    state.phase === "human-required" ||
    state.phase === "review"
  );
}

export function formatHumanDecision(decision: HumanDecisionState, label = "Structured human decision"): string {
  return [
    `${label}:`,
    `- Type: ${decision.type}`,
    `- Authority: ${isAuthoritativeHumanDecision(decision) ? "authoritative" : "context-only"}`,
    `- Source: ${decision.source}`,
    `- Decided at: ${decision.decidedAt}`,
    decision.actor ? `- Actor: ${decision.actor}` : null,
    decision.prHeadSha ? `- PR head SHA: ${decision.prHeadSha}` : null,
    decision.validationEvidence ? `- Validation evidence: ${decision.validationEvidence}` : null,
    decision.ciState ? `- CI state: ${decision.ciState}` : null,
    decision.findings ? `- Findings: ${decision.findings}` : null,
    decision.summary ? `- Summary: ${decision.summary}` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatLinearComment(id: string, author: string | null | undefined, timestamp: string | null | undefined, body: string): string {
  return [`- Comment ${id}${author ? ` by ${author}` : ""}${timestamp ? ` at ${timestamp}` : ""}:`, indentBlock(truncateForPrompt(body.trim(), 1200))].join("\n");
}

export async function refreshMergeShepherdHumanDecisionsIfNeeded(input: {
  issue: Issue;
  state: IssueState | null;
  fetchIssueComments?: (issue: Issue) => Promise<IssueComment[] | null>;
  ingestHumanDecisions: (issue: Issue, state: IssueState | null, comments: IssueComment[], options: { authoritativeCommentSet?: boolean }) => Promise<IssueState | null>;
  logger: { write(entry: { type: string; issueId?: string; issueIdentifier?: string; message?: string }): Promise<unknown> };
}): Promise<IssueState | null> {
  const needsSupervisorDecision = input.state?.reviewStatus !== "approved" && !reviewSupervisorMergeDecision(input.state);
  const needsFreshSplitDecision = isReviewSplitRecommendationBlocking(input.state);
  if (!needsSupervisorDecision && !needsFreshSplitDecision) return input.state;
  if (!input.fetchIssueComments) return input.state;
  try {
    const comments = await input.fetchIssueComments(input.issue);
    if (!comments) return input.state;
    return (await input.ingestHumanDecisions(input.issue, input.state, comments, { authoritativeCommentSet: true })) ?? input.state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await input.logger.write({
      type: "merge_shepherd_human_decision_refresh_warning",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message
    });
    return input.state;
  }
}

export function linearCommentKey(event: string, issueIdentifier: string): string {
  return `${event}:${issueIdentifier}`;
}

export function linearCommentMarker(event: string, issueIdentifier: string): string {
  return `<!-- agentos:event=${linearCommentKey(event, issueIdentifier)} -->`;
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function truncateForPrompt(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 15).trimEnd()}... [truncated]`;
}
