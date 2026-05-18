import type { AgentEvent, ContextBudgetState, IssueState, ScopeReportState } from "./types.js";

export function scopeReportDetails(state: IssueState | null): string {
  const report = state?.scopeReport;
  if (!report) return "Scope report: none recorded";
  if (scopeReportIsHistorical(state, report)) {
    return [
      `Scope report: historical/non-blocking ${report.scopeSize}${report.likelyLarge ? " (likely large)" : ""}`,
      `Scope score: ${report.score == null ? "unclear" : `${report.score}/${report.largeThreshold}`} (medium threshold ${report.mediumThreshold}, large threshold ${report.largeThreshold})`,
      `Scope scoring source: ${report.scoringTextSource}`,
      `Scope report note: prior dispatch advice is stale because lifecycle is ${state?.lifecycleStatus ?? "unknown"} and phase is ${state?.phase ?? "unknown"}.`
    ].join("\n");
  }
  const lines = [
    `Scope report: ${report.scopeSize}${report.likelyLarge ? " (likely large)" : ""}`,
    `Scope score: ${report.score == null ? "unclear" : `${report.score}/${report.largeThreshold}`} (medium threshold ${report.mediumThreshold}, large threshold ${report.largeThreshold})`,
    `Scope scoring source: ${report.scoringTextSource}`,
    report.scoringReasons.length ? `Scope scoring reasons:\n${formatScopeScoreReasons(report.scoringReasons)}` : "Scope scoring reasons: none",
    report.ignoredSections.length ? `Ignored scope sections: ${report.ignoredSections.join(", ")}` : null,
    `Planning re-entry: ${report.planningReentry.status} - ${report.planningReentry.reason}`,
    `Scope dispatch advice: ${report.dispatchAdvice.shouldBlock ? "blocked" : "allowed"}${report.dispatchAdvice.reason ? ` - ${report.dispatchAdvice.reason}` : ""}`,
    `Scope next safe action: ${report.dispatchAdvice.nextSafeAction}`
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function scopeReportStatusSuffix(report: ScopeReportState | null | undefined): string {
  if (!report) return "";
  const score = report.score == null ? "unclear" : `${report.score}/${report.largeThreshold}`;
  const reasons = report.scoringReasons.length ? `; reasons ${report.scoringReasons.map((reason) => `+${reason.score} ${reason.reason}`).join("; ")}` : "";
  return `; scope score ${score}; source ${report.scoringTextSource}${reasons}`;
}

export function contextBudgetDetails(state: IssueState | null): string {
  const budget = state?.contextBudget;
  if (!budget) return "Context budget: none recorded";
  const lines = [
    `Context budget: ${budget.status} (${budget.kind})`,
    `Context prompt estimate: ${budget.estimatedPromptTokens}/${budget.maxPromptTokens} token(s); cumulative ${budget.cumulativeEstimatedTokens}/${budget.maxCumulativeTokens}`,
    budget.exceededReasons?.length ? `Context budget errors:\n${budget.exceededReasons.map((reason) => `- ${reason}`).join("\n")}` : null
  ];
  const large = budget.sections.filter((section) => section.large);
  if (large.length) lines.push("Large context sections:", ...large.map(formatContextSection));
  return lines.filter((line): line is string => line !== null).join("\n");
}

export function runtimeWarningDetails(entries: AgentEvent[], identifier: string): string {
  const summary = runtimeWarningSummary(entries, identifier);
  if (!summary) return "Runtime warning summary: none recorded";
  return `Runtime warning summary: ${summary.summary}\nRuntime warning next action: ${summary.nextAction}`;
}

export function runtimeWarningSummary(entries: AgentEvent[], identifier: string): { summary: string; nextAction: string } | null {
  const warningEvents = entries.filter((entry) => entry.issueIdentifier?.toLowerCase() === identifier.toLowerCase() && isPluginOrCacheWarning(entry));
  if (warningEvents.length === 0) return null;
  const latest = warningEvents.at(-1);
  return {
    summary: `${warningEvents.length} plugin/cache stderr warning event(s) recorded; latest ${latest?.timestamp ?? "unknown time"}. Raw stderr is omitted from status output.`,
    nextAction: "inspect the referenced run artifact if the warning persists after the next clean daemon restart"
  };
}

export function recentEventMessage(entry: AgentEvent): string {
  if (isPluginOrCacheWarning(entry)) return "plugin/cache stderr warning omitted from status output";
  return entry.message ?? "";
}

function scopeReportIsHistorical(state: IssueState | null, report: ScopeReportState): boolean {
  if (!state || !report.dispatchAdvice.shouldBlock) return false;
  if (state.lifecycleStatus === "planning_required" || state.phase === "needs-input") return false;
  return true;
}

function formatScopeScoreReasons(reasons: ScopeReportState["scoringReasons"]): string {
  return reasons.map((reason) => `- +${reason.score} ${reason.reason}`).join("\n");
}

function formatContextSection(section: ContextBudgetState["sections"][number]): string {
  return `- ${section.name}: ~${section.estimatedTokens} token(s), ${section.chars} char(s); reason: ${section.reason}`;
}

function isPluginOrCacheWarning(entry: AgentEvent): boolean {
  if (!/codex_stderr/i.test(entry.type)) return false;
  const message = entry.message ?? "";
  return /\b(plugin|cache|manifest)\b/i.test(message) && /\b(warn|warning|deprecated|failed to load)\b/i.test(message);
}
