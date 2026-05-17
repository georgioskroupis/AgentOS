import { isAuthoritativeHumanDecision, latestHumanDecision } from "./issue-state.js";
import { redactText } from "./redaction.js";
import type { HumanDecisionState, IssueComment, IssueState } from "./types.js";
import type { ScopeEvidence } from "./scope-report.js";

export function buildLinearCommentEvidence(comments: IssueComment[] | null): ScopeEvidence["linearComments"] {
  const sorted = sortCommentsByActivity(comments ?? []);
  const latest = sorted.at(-1) ?? null;
  return {
    fetched: comments !== null,
    present: sorted.length > 0,
    count: sorted.length,
    latestCommentId: latest?.id ?? null,
    latestCommentAuthor: latest?.author ?? null,
    latestCommentAt: latest ? commentActivityAt(latest) : null,
    recent: sorted.slice(-5).map((comment) => ({
      id: comment.id,
      author: comment.author ?? null,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
      bodyPreview: cleanSingleLine(comment.body, 240),
      hasStructuredHumanDecision: hasStructuredHumanDecision(comment.body)
    }))
  };
}

export function buildHumanDecisionEvidence(state: IssueState | null): ScopeEvidence["humanDecisions"] {
  const decisions = uniqueHumanDecisions([...(state?.humanDecisions ?? []), ...(state?.lastHumanDecision ? [state.lastHumanDecision] : [])]);
  const latest = state?.lastHumanDecision ?? latestHumanDecision(decisions);
  return {
    present: decisions.length > 0,
    count: decisions.length,
    latest: latest
      ? {
          type: latest.type,
          source: latest.source,
          authority: isAuthoritativeHumanDecision(latest) ? "authoritative" : "context-only",
          actor: latest.actor ?? null,
          decidedAt: latest.decidedAt,
          commentId: latest.commentId ?? null,
          prHeadSha: latest.prHeadSha ?? null,
          validationEvidence: latest.validationEvidence ?? null,
          ciState: latest.ciState ?? null,
          findings: latest.findings ?? null,
          summary: latest.summary ?? null,
          bodyPreview: latest.body ? cleanSingleLine(latest.body, 240) : null
        }
      : null
  };
}

function sortCommentsByActivity(comments: IssueComment[]): IssueComment[] {
  return comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => {
      const byTime = (commentActivityAt(a.comment) ?? "").localeCompare(commentActivityAt(b.comment) ?? "");
      return byTime !== 0 ? byTime : a.index - b.index;
    })
    .map((entry) => entry.comment);
}

function commentActivityAt(comment: IssueComment): string | null {
  return comment.updatedAt ?? comment.createdAt ?? null;
}

function hasStructuredHumanDecision(body: string): boolean {
  return /^(AgentOS-Human-Decision|Human-Decision|Decision-Type):/im.test(body);
}

function uniqueHumanDecisions(decisions: HumanDecisionState[]): HumanDecisionState[] {
  const byKey = new Map<string, HumanDecisionState>();
  for (const decision of decisions) {
    byKey.set(decision.commentId ? `comment:${decision.commentId}` : `${decision.source}:${decision.decidedAt}:${decision.type}:${decision.body ?? ""}`, decision);
  }
  return [...byKey.values()].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
}

function cleanSingleLine(value: string, maxLength: number): string {
  const redacted = redactText(value).trim().replace(/\s+/g, " ");
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 15)).trimEnd()}... [truncated]`;
}
