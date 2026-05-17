import type { ScopeEvidence, ScopeImplementationStatus, ScopeSize } from "./scope-report.js";
import type { ScopeTextSelection } from "./scope-report-scope-text.js";
import type { Issue, IssueState, ScopeScoreReasonState } from "./types.js";

export interface ScopeEstimateResult {
  scopeSize: ScopeSize;
  reasons: string[];
  score: number | null;
  scoreReasons: ScopeScoreReasonState[];
}

export const SCOPE_MEDIUM_THRESHOLD = 2;
export const SCOPE_LARGE_THRESHOLD = 5;

export function estimateTouchedSubsystems(issue: Issue, state: IssueState | null, evidence: ScopeEvidence, scopeText: ScopeTextSelection): string[] {
  const text = scopeText.text || issueText(issue);
  const matches: string[] = [];
  const keywordMap: Array<[string, RegExp]> = [
    ["orchestration", /\b(orchestrator|scheduler|dispatch|candidate|retry|reconciliation|lifecycle|linear)\b/i],
    ["runner-runtime", /\b(codex|app server|runner|stall|timeout|token|event volume|runtime)\b/i],
    ["workspace-recovery", /\b(workspace|worktree|branch|upstream|dirty|recoverable)\b/i],
    ["github-pr", /\b(github|pull request| pr |status checks?|ci|merge)\b/i],
    ["validation", /\b(validation|agent-check|test|vitest|typecheck|build)\b/i],
    ["harness-templates", /\b(harness|template|profile|skill|agent[s]?\.md)\b/i],
    ["workflow-docs", /\b(workflow|readme|architecture|docs?|quality|runbook)\b/i],
    ["cli", /\b(cli|command|commander|agent-os)\b/i],
    ["security", /\b(security|secret|credential|trust|auth|token)\b/i],
    ["registry", /\b(registry|multi-project|project registry|daemon)\b/i]
  ];
  for (const [subsystem, pattern] of keywordMap) {
    if (pattern.test(text)) matches.push(subsystem);
  }
  if (state?.validation || evidence.lastRun.quietValidationStop) matches.push("validation");
  if (evidence.workspace.recoverable) matches.push("workspace-recovery");
  if (evidence.pullRequests.present) matches.push("github-pr");
  return unique(matches).length ? unique(matches) : ["unknown"];
}

export function estimateScope(
  issue: Issue,
  implementationStatus: ScopeImplementationStatus,
  likelyTouchedSubsystems: string[],
  evidence: ScopeEvidence,
  scopeText: ScopeTextSelection
): ScopeEstimateResult {
  if (implementationStatus === "already_satisfied") {
    return {
      scopeSize: "small",
      reasons: ["prior handoff says no implementation work is needed"],
      score: 0,
      scoreReasons: []
    };
  }
  if (implementationStatus === "unclear") {
    return {
      scopeSize: "unclear",
      reasons: ["scope cannot be estimated from current evidence"],
      score: null,
      scoreReasons: []
    };
  }

  const text = scopeText.text || issueText(issue);
  const concreteSubsystems = likelyTouchedSubsystems.filter((subsystem) => subsystem !== "unknown");
  const scoreReasons: ScopeScoreReasonState[] = [];
  let score = 0;
  const addScore = (amount: number, reason: string) => {
    score += amount;
    scoreReasons.push({ score: amount, reason });
  };
  if (concreteSubsystems.length >= 3) {
    addScore(concreteSubsystems.length, `touches ${concreteSubsystems.length} likely subsystem(s)`);
  }
  if (scopeText.scoredAcceptanceBulletCount >= 5) {
    addScore(2, `has ${scopeText.scoredAcceptanceBulletCount} acceptance/detail bullet(s)`);
  }
  if (/\b(end-to-end|roadmap|migration|architecture|orchestrator|workflow|large|broad|dependencies|decompose|guardrail)\b/i.test(text)) {
    addScore(2, "contains broad orchestration or roadmap language");
  }
  if (text.length > 1200) {
    addScore(1, "scored implementation text is long");
  }
  if (evidence.lastRun.eventCount > 200 || (evidence.lastRun.tokenTotal ?? 0) > 100_000) {
    addScore(2, "prior run had high event or token volume");
  }
  if (evidence.workspace.recoverable) {
    addScore(1, "recoverable partial workspace must be preserved");
  }

  const reasons = scoreReasons.map((reason) => reason.reason);
  if (score >= SCOPE_LARGE_THRESHOLD) return { scopeSize: "large", reasons, score, scoreReasons };
  if (score >= SCOPE_MEDIUM_THRESHOLD) return { scopeSize: "medium", reasons: reasons.length ? reasons : ["moderate subsystem or acceptance detail"], score, scoreReasons };
  return { scopeSize: "small", reasons: reasons.length ? reasons : ["limited issue text and few subsystem signals"], score, scoreReasons };
}

export function acceptanceBulletCount(description: string | null): number {
  return (description ?? "").split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
}

export function formatScoreReasons(reasons: ScopeScoreReasonState[]): string {
  return reasons.map((reason) => `+${reason.score} ${reason.reason}`).join("; ");
}

function issueText(issue: Issue): string {
  return [issue.title, issue.description, issue.labels.join(" ")].filter(Boolean).join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
