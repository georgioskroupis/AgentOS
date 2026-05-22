import type { IssueState } from "./types.js";

export function externalStateDriftDetails(state: IssueState | null): string | null {
  const drift = state?.externalStateDrift;
  if (!drift) return "External state drift: none recorded";
  return [
    `External state drift: ${drift.status}`,
    `Expected tracker state: ${drift.expectedState}`,
    `Observed tracker state: ${drift.currentState}`,
    `Detected at: ${drift.detectedAt}`,
    drift.reconciledAt ? `Reconciled at: ${drift.reconciledAt}` : null,
    `Reason: ${drift.reason}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function externalStateDriftWarning(issue: IssueState): string {
  const drift = issue.externalStateDrift;
  if (!drift) return "external state drift recorded";
  const base = `external state drift: expected ${drift.expectedState}, observed ${drift.currentState}`;
  return drift.status === "reconciled" ? `${base}; reconciled back to ${drift.expectedState}` : `${base}; ${drift.reason}`;
}
