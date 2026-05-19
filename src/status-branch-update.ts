import type { IssueState } from "./types.js";

export function branchUpdateDetails(state: IssueState | null): string | null {
  const update = state?.branchUpdate;
  if (!update) return "Branch freshness: none recorded";
  return [
    `Branch freshness: ${update.status} (${update.updatedAt})`,
    `- PR: ${update.prUrl}`,
    update.beforeHeadSha ? `- Head before: ${shortSha(update.beforeHeadSha)}` : null,
    update.afterHeadSha ? `- Head after: ${shortSha(update.afterHeadSha)}` : null,
    update.mergeStateStatus ? `- GitHub merge state: ${update.mergeStateStatus}` : null,
    `- Reason: ${update.reason}`,
    `- Next: ${update.operatorGuidance}`,
    update.error ? `- Error: ${update.error}` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
