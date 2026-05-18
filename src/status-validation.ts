import type { IssueState, ValidationCommandState, ValidationState } from "./types.js";

export function validationDetails(state: IssueState | null): string {
  const validation = state?.validation;
  if (!validation) return "Validation: none recorded";
  const headLines = validationHeadDetails(state);
  const lines = [
    `Validation: ${validation.status}${validation.finalStatus ? ` (final: ${validation.finalStatus})` : ""}`,
    validation.runId ? `Validation run: ${validation.runId}` : null,
    validation.acceptedCommands?.length ? `Accepted validation commands:\n${commandLines(validation.acceptedCommands)}` : null,
    validation.additionalPassingCommands?.length ? `Additional passing commands:\n${commandLines(validation.additionalPassingCommands)}` : null,
    validation.failedHistoricalAttempts?.length ? `Failed historical attempts:\n${commandLines(validation.failedHistoricalAttempts)}` : null,
    headLines.length ? `Evidence heads:\n${headLines.join("\n")}` : null,
    validation.githubCi ? `GitHub CI: ${validation.githubCi.status}${validation.githubCi.headSha ? ` (${validation.githubCi.headSha})` : ""}${validation.githubCi.reused === true ? " [reused]" : validation.githubCi.reused === false ? " [refreshed]" : ""}` : null,
    validation.budget ? `Validation budget: ${validation.budget.status} - ${validation.budget.summary}` : null,
    validation.reuseProfile
      ? [
          "Validation reuse profile:",
          `- workflow/config hash: ${validation.reuseProfile.workflowConfigHash}`,
          `- trust: ${validation.reuseProfile.trustMode}`,
          `- automation: ${validation.reuseProfile.automationProfile}/${validation.reuseProfile.automationRepairPolicy}`,
          `- risk: ${validation.reuseProfile.riskProfile}`
        ].join("\n")
      : null,
    validation.errors?.length ? `Validation errors:\n${validation.errors.map((error) => `- ${error}`).join("\n")}` : null
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function appendEvidenceStatus(issue: IssueState, line: string): string {
  const budget = validationBudgetSummary(issue.validation);
  const summary = validationHeadSummary(issue);
  return [line, budget, summary].filter(Boolean).join("; ");
}

function validationBudgetSummary(validation: ValidationState | undefined): string | null {
  if (!validation?.budget) return null;
  const label = validation.budget.status === "reused" ? "validation evidence reused" : validation.budget.status === "fresh" ? "validation evidence fresh/rerun" : "validation budget exceeded";
  return `${label}: ${validation.budget.fullValidationRunsForHead}/${validation.budget.maxFullValidationRunsPerHead} full run(s) for head`;
}

function validationHeadSummary(issue: IssueState): string | null {
  const details = validationHeadDetails(issue);
  if (details.length === 0) return null;
  return `evidence heads: ${details.map((line) => line.replace(/^- /, "")).join("; ")}`;
}

function validationHeadDetails(issue: IssueState | null): string[] {
  if (!issue?.validation && !issue?.headSha) return [];
  const selectedHead = issue?.headSha ?? null;
  const validationHead = issue?.validation?.repoHead ?? null;
  const ciHead = issue?.validation?.githubCi?.headSha ?? null;
  return [
    `- Selected PR head: ${formatComparedHead(selectedHead, selectedHead, { selected: true })}`,
    `- Validation repoHead: ${formatComparedHead(validationHead, selectedHead)}`,
    `- CI/check head: ${formatComparedHead(ciHead, selectedHead)}`
  ];
}

function formatComparedHead(value: string | null | undefined, selectedHead: string | null | undefined, options: { selected?: boolean } = {}): string {
  if (!value) return "unknown";
  const label = options.selected ? "current" : !selectedHead ? "unknown: no selected PR head" : sameSha(value, selectedHead) ? "current" : `stale; expected ${shortSha(selectedHead)}`;
  return `${shortSha(value)} (${label})`;
}

function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function commandLines(commands: ValidationCommandState[]): string {
  return commands
    .map((command) => `- ${command.name}: exitCode ${command.exitCode}, finished ${command.finishedAt}`)
    .join("\n");
}
