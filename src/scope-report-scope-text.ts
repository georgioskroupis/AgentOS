import { latestAuthoritativeHumanDecision } from "./issue-state.js";
import { acceptanceBulletCount } from "./scope-report-scoring.js";
import type { HumanDecisionState, Issue, IssueComment, IssueState, ScopePlanningReentryState, ScopeTextSource } from "./types.js";

export interface ScopeTextSelection {
  text: string;
  source: ScopeTextSource;
  scoredAcceptanceBulletCount: number;
  ignoredSections: string[];
  activeScope: {
    present: boolean;
    bounded: boolean;
    text: string | null;
    excerpt: string | null;
    reason: string | null;
  };
  decompositionEvidence: {
    present: boolean;
    references: string[];
  };
  latestDecision: HumanDecisionState | null;
  priorPlanningPause: boolean;
  planningReentry: ScopePlanningReentryState;
}

export function selectScopeText(issue: Issue, state: IssueState | null, linearComments: IssueComment[] | null): ScopeTextSelection {
  const latestDecision = latestAuthoritativeHumanDecision([...(state?.humanDecisions ?? []), ...(state?.lastHumanDecision ? [state.lastHumanDecision] : [])]);
  const trustedPlanning = extractTrustedPlanningEvidence(latestDecision);
  const issueSelection = selectIssueScopeText(issue);
  const useTrustedActiveScope = trustedPlanning.activeScope.present && trustedPlanning.activeScope.bounded && trustedPlanning.activeScope.text;
  const text = useTrustedActiveScope ? [issue.title, trustedPlanning.activeScope.text, issue.labels.join(" ")].filter(Boolean).join("\n") : issueSelection.text;
  const source: ScopeTextSource = useTrustedActiveScope ? "trusted_active_scope" : issueSelection.source;
  const priorPlanningPause = hasPriorPlanningPause(state, linearComments);
  const planningReentry = planningReentryState(priorPlanningPause, latestDecision, trustedPlanning.activeScope, trustedPlanning.decompositionEvidence);
  return {
    text,
    source,
    scoredAcceptanceBulletCount: acceptanceBulletCount(text),
    ignoredSections: useTrustedActiveScope ? [...issueSelection.ignoredSections, "issue text superseded by trusted Active-Scope"] : issueSelection.ignoredSections,
    activeScope: trustedPlanning.activeScope,
    decompositionEvidence: trustedPlanning.decompositionEvidence,
    latestDecision,
    priorPlanningPause,
    planningReentry
  };
}

function extractTrustedPlanningEvidence(decision: HumanDecisionState | null): Pick<ScopeTextSelection, "activeScope" | "decompositionEvidence"> {
  if (decision?.type !== "fix_findings" || !decision.body?.trim()) {
    return {
      activeScope: { present: false, bounded: false, text: null, excerpt: null, reason: null },
      decompositionEvidence: { present: false, references: [] }
    };
  }
  const activeText = extractActiveScopeSection(decision.body);
  const activeScope = activeScopeState(activeText);
  const references = extractLinkedDecompositionReferences(decision.body);
  return {
    activeScope,
    decompositionEvidence: { present: references.length > 0, references }
  };
}

function activeScopeState(text: string | null): ScopeTextSelection["activeScope"] {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return { present: false, bounded: false, text: null, excerpt: null, reason: null };
  const bullets = acceptanceBulletCount(trimmed);
  if (trimmed.length > 2000) {
    return {
      present: true,
      bounded: false,
      text: trimmed,
      excerpt: cleanExcerpt(trimmed, 180),
      reason: "trusted Active-Scope is longer than 2000 characters"
    };
  }
  if (bullets > 10) {
    return {
      present: true,
      bounded: false,
      text: trimmed,
      excerpt: cleanExcerpt(trimmed, 180),
      reason: `trusted Active-Scope has ${bullets} acceptance/detail bullet(s)`
    };
  }
  return { present: true, bounded: true, text: trimmed, excerpt: cleanExcerpt(trimmed, 180), reason: "trusted Active-Scope is bounded" };
}

function planningReentryState(
  priorPlanningPause: boolean,
  latestDecision: HumanDecisionState | null,
  activeScope: ScopeTextSelection["activeScope"],
  decompositionEvidence: ScopeTextSelection["decompositionEvidence"]
): ScopePlanningReentryState {
  if (!priorPlanningPause) {
    return {
      status: "not_required",
      reason: "no prior planning pause was detected",
      decisionCommentId: latestDecision?.commentId ?? null,
      activeScopePresent: activeScope.present,
      activeScopeBounded: activeScope.bounded,
      decompositionEvidencePresent: decompositionEvidence.present
    };
  }
  if (latestDecision?.type !== "fix_findings") {
    return {
      status: "missing",
      reason: "prior planning pause needs an authoritative fix-findings decision with bounded Active-Scope or linked decomposition evidence",
      decisionCommentId: latestDecision?.commentId ?? null,
      activeScopePresent: activeScope.present,
      activeScopeBounded: activeScope.bounded,
      decompositionEvidencePresent: decompositionEvidence.present
    };
  }
  if (activeScope.present && activeScope.bounded) {
    return {
      status: "satisfied",
      reason: "trusted fix-findings decision provides bounded Active-Scope",
      decisionCommentId: latestDecision.commentId ?? null,
      activeScopePresent: true,
      activeScopeBounded: true,
      decompositionEvidencePresent: decompositionEvidence.present
    };
  }
  if (decompositionEvidence.present) {
    return {
      status: "satisfied",
      reason: "trusted fix-findings decision links decomposition evidence",
      decisionCommentId: latestDecision.commentId ?? null,
      activeScopePresent: activeScope.present,
      activeScopeBounded: activeScope.bounded,
      decompositionEvidencePresent: true
    };
  }
  return {
    status: "missing",
    reason: activeScope.reason ?? "prior planning pause needs bounded Active-Scope or linked decomposition evidence",
    decisionCommentId: latestDecision.commentId ?? null,
    activeScopePresent: activeScope.present,
    activeScopeBounded: activeScope.bounded,
    decompositionEvidencePresent: false
  };
}

function hasPriorPlanningPause(state: IssueState | null, linearComments: IssueComment[] | null): boolean {
  const stateText = [state?.stopReason, state?.lastError].filter(Boolean).join(" ");
  if (/planning\/decomposition|likely-large scope needs planning|planning recommended/i.test(stateText)) return true;
  return (linearComments ?? []).some((comment) => /agentos:event=planning_recommended|planning recommended|likely-large scope needs planning/i.test(comment.body));
}

function selectIssueScopeText(issue: Issue): { text: string; source: ScopeTextSource; ignoredSections: string[] } {
  const description = issue.description ?? "";
  const active = extractIssueSections(description, "active");
  const labels = issue.labels.join(" ");
  if (active.text.trim()) {
    return {
      text: [issue.title, active.text, labels].filter(Boolean).join("\n"),
      source: "issue_active_sections",
      ignoredSections: active.ignoredSections
    };
  }
  const filtered = extractIssueSections(description, "filter");
  const text = [issue.title, filtered.text.trim() || description, labels].filter(Boolean).join("\n");
  return {
    text,
    source: filtered.ignoredSections.length ? "issue_without_background" : "issue_full_text",
    ignoredSections: filtered.ignoredSections
  };
}

function extractIssueSections(text: string, mode: "active" | "filter"): { text: string; ignoredSections: string[] } {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const ignoredSections: string[] = [];
  let include = mode === "filter";
  let foundActive = false;
  for (const line of lines) {
    const header = parseSectionHeader(line);
    if (header) {
      if (isIgnoredScopeSection(header.key)) {
        include = false;
        ignoredSections.push(header.label);
        continue;
      }
      if (isActiveScopeSection(header.key)) {
        include = true;
        foundActive = true;
        if (header.inline) out.push(header.inline);
        continue;
      }
      if (mode === "active" && foundActive) break;
      include = mode === "filter";
      if (include && header.inline) out.push(header.inline);
      continue;
    }
    if (include) out.push(line);
  }
  if (mode === "active" && !foundActive) return { text: "", ignoredSections: unique(ignoredSections) };
  return { text: out.join("\n").trim(), ignoredSections: unique(ignoredSections) };
}

function extractActiveScopeSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let capturing = false;
  for (const line of lines) {
    const header = parseSectionHeader(line);
    if (header) {
      if (isTrustedActiveScopeStart(header.key)) {
        capturing = true;
        if (header.inline) out.push(header.inline);
        continue;
      }
      if (capturing && isTrustedActiveScopeContinuation(header.key)) {
        if (header.inline) out.push(header.inline);
        continue;
      }
      if (capturing) break;
    }
    if (capturing) out.push(line);
  }
  const trimmed = out.join("\n").trim();
  return trimmed || null;
}

function extractLinkedDecompositionReferences(text: string): string[] {
  const references: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const header = parseSectionHeader(line);
    if (!header || !isDecompositionEvidenceSection(header.key) || !header.inline) continue;
    if (isLinkedReference(header.inline)) references.push(header.inline);
  }
  return unique(references);
}

function parseSectionHeader(line: string): { key: string; label: string; inline: string } | null {
  const match = line.match(/^\s*(?:#{1,6}\s*)?([A-Za-z][A-Za-z0-9 /_-]{1,80})\s*:\s*(.*)$/);
  if (!match) return null;
  const label = match[1].trim();
  return {
    key: label.toLowerCase().replace(/[_\s/]+/g, "-"),
    label,
    inline: match[2].trim()
  };
}

function isTrustedActiveScopeStart(key: string): boolean {
  return ["active-scope", "active-implementation-scope", "implementation-scope", "current-scope"].includes(key);
}

function isTrustedActiveScopeContinuation(key: string): boolean {
  return ["done-when", "acceptance-criteria", "definition-of-done", "criteria"].includes(key);
}

function isActiveScopeSection(key: string): boolean {
  return ["acceptance-criteria", "definition-of-done", "done-when", "active-scope", "active-implementation-scope", "implementation-scope", "current-scope"].includes(key);
}

function isIgnoredScopeSection(key: string): boolean {
  return [
    "background",
    "rationale",
    "history",
    "issue-history",
    "previous-attempts",
    "follow-up",
    "follow-ups",
    "split-follow-up",
    "split-follow-ups",
    "future-work",
    "out-of-scope",
    "non-goals",
    "bootstrap-note",
    "notes",
    "context"
  ].includes(key);
}

function isDecompositionEvidenceSection(key: string): boolean {
  return ["decomposition-evidence", "decomposition-artifact", "planning-artifact", "split-issues", "split-issue", "follow-up-issues", "follow-up-issue"].includes(key);
}

function isLinkedReference(value: string): boolean {
  return /https?:\/\/|\b[A-Z][A-Z0-9]+-\d+\b|(?:^|[\s`'"])(?:\.{1,2}\/|\/)?[A-Za-z0-9._/-]+\.(?:md|json|txt)\b/i.test(value);
}

function cleanExcerpt(value: string, maxLength: number): string {
  const singleLine = value.trim().replace(/\s+/g, " ");
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 15)).trimEnd()}... [truncated]`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
