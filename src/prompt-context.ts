import { pullRequestUrls } from "./issue-state.js";
import type { IssueState } from "./types.js";

export function existingImplementationAuditContext(state: IssueState | null): string {
  const lines = [
    "",
    "## Existing Implementation Audit Requirement",
    "",
    "Before editing, compare the issue acceptance criteria against existing source, docs, tests, validation evidence, local issue state, workspaces, and PR metadata.",
    "Report whether the scope is already satisfied, partially satisfied, or missing. If it is partially satisfied, continue from the existing artifacts instead of duplicating modules, commands, states, docs, scripts, or workflow concepts.",
    state?.outcome ? `Recorded prior outcome: ${state.outcome}` : null,
    state?.phase ? `Recorded phase: ${state.phase}` : null,
    state?.reviewStatus ? `Recorded review status: ${state.reviewStatus}` : null,
    state?.workspacePath ? `Recorded workspace: ${state.workspacePath}` : null,
    pullRequestUrls(state).length ? `Recorded PRs: ${pullRequestUrls(state).join(", ")}` : null
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}
