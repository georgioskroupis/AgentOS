import type { PreDispatchScopeReport } from "./scope-report.js";
import { formatScore } from "./scope-report-scoring.js";

export function planningRecommendedCommentBody(report: PreDispatchScopeReport): string {
  return [
    "### AgentOS planning recommended",
    "",
    scopePlanningCommentIntro(report),
    "",
    `- Scope: ${report.scopeSize}`,
    `- Scope score: ${report.scopeScoring.score == null ? "unclear" : `${report.scopeScoring.score}/${report.scopeScoring.largeThreshold}`}`,
    `- Scope scoring source: ${report.scopeScoring.textSource}`,
    report.scopeScoring.reasons.length ? "- Scope scoring reasons:" : "- Scope scoring reasons: none",
    ...report.scopeScoring.reasons.map((reason) => `  - ${formatScore(reason.score)} ${reason.reason}`),
    report.scopeScoring.ignoredSections.length ? `- Ignored scope sections: ${report.scopeScoring.ignoredSections.join(", ")}` : null,
    `- Planning re-entry: ${report.evidence.planningReentry.status} - ${report.evidence.planningReentry.reason}`,
    `- Next safe action: ${report.dispatchAdvice.nextSafeAction}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function scopePlanningCommentIntro(report: PreDispatchScopeReport): string {
  if (report.likelyLarge) {
    return "AgentOS refused to start a fresh implementation turn because the pre-dispatch scope report classified this issue as likely large.";
  }
  if (report.evidence.planningReentry.status === "missing") {
    return "AgentOS refused to start a fresh implementation turn because a prior planning pause still needs bounded Active-Scope or linked decomposition evidence.";
  }
  return "AgentOS refused to start a fresh implementation turn because the pre-dispatch scope guardrail blocked implementation dispatch.";
}
