import { isAuthoritativeHumanDecision } from "./issue-state.js";
import type { HumanDecisionState } from "./types.js";

export const RECENT_LINEAR_COMMENT_LIMIT = 20;
export const GUARDRAIL_LINEAR_COMMENT_LIMIT = Number.MAX_SAFE_INTEGER;

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
