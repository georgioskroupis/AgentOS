import type { RetryEntry } from "./orchestrator-retry.js";
import { categorizeRunError } from "./run-errors.js";
import type { IssueState, Workspace } from "./types.js";

export function runStartedCommentBody(workspace: Workspace, attemptLabel: number): string {
  return [
    "### AgentOS started",
    "",
    "The Symphony loop picked up this issue and started a Codex run.",
    "",
    `- Attempt: ${attemptLabel}`,
    `- Workspace: \`${workspace.path}\``,
    `- Branch: \`agent/${workspace.workspaceKey}\``,
    "- Logs: `.agent-os/runs/agent-os.jsonl`"
  ].join("\n");
}

export function retryScheduledCommentBody(workspace: Workspace, retry: RetryEntry, maxAttempts: number): string {
  return [
    "### AgentOS retry scheduled",
    "",
    "Codex did not complete the run successfully. The Symphony loop will retry automatically.",
    "",
    `- Next retry: ${retry.attempt} of ${maxAttempts}`,
    `- Retry after: ${new Date(retry.dueAtMs).toISOString()}`,
    `- Workspace: \`${workspace.path}\``,
    `- Error: ${retry.error ?? "unknown"}`
  ].join("\n");
}

export function capacityWaitScheduledCommentBody(workspace: Workspace, retry: RetryEntry, maxAttempts: number, reason: string): string {
  return [
    "### AgentOS capacity wait scheduled",
    "",
    "Codex reported a usage-capacity reset time. AgentOS will wait until that reset instead of consuming the normal retry budget on rapid backoff.",
    "",
    `- Resume after: ${new Date(retry.dueAtMs).toISOString()}`,
    `- Current retry attempt remains: ${retry.attempt} of ${maxAttempts}`,
    `- Workspace: \`${workspace.path}\``,
    `- Reason: ${reason}`,
    `- Error: ${retry.error ?? "unknown"}`
  ].join("\n");
}

export function runFailedCommentBody(input: { workspace: Workspace; attemptLabel: number; error: string; recoveryText?: string | null }): string {
  return [
    "### AgentOS needs human input",
    "",
    "Codex could not complete this issue within the configured retry budget.",
    "",
    `- Last attempt: ${input.attemptLabel}`,
    `- Workspace: \`${input.workspace.path}\``,
    `- Error: ${input.error}`,
    input.recoveryText ? "" : null,
    input.recoveryText ?? null,
    "",
    "Please adjust the issue, repo, or workflow instructions before returning it to an active state."
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function recoveryNeededCommentBody(recoveryText: string): string {
  return ["### AgentOS recovery needed", "", "AgentOS found recoverable partial work and refused to start a fresh implementation turn.", "", recoveryText].join("\n");
}

export function needsInputCommentBody(workspace: Workspace, attemptLabel: number, error: string): string {
  return [
    "### AgentOS needs human input",
    "",
    "Codex requested elicitation, approval, user input, or interactive confirmation. Current policy denies those requests by default, so AgentOS stopped the run instead of waiting indefinitely.",
    "",
    `- Attempt: ${attemptLabel}`,
    `- Workspace: \`${workspace.path}\``,
    `- Error: ${error}`,
    "",
    "Please handle the requested input manually before returning this issue to an active state."
  ].join("\n");
}

export function mergeWaitingCommentBody(prUrl: string, reason: string): string {
  return ["### AgentOS merge waiting", "", "The issue is in `Merging`, but the pull request is not ready yet.", "", `- PR: ${prUrl}`, `- Reason: ${reason}`].join("\n");
}

export type MergeFailureRoute = "review" | "needs-input" | "running";

export function mergeFailedCommentBody(input: { prUrl?: string; reason: string; route: MergeFailureRoute; targetState?: string | null; reviewGate?: boolean }): string {
  return [
    input.route === "running" ? "### AgentOS merge returned to active repair" : "### AgentOS merge needs human review",
    "",
    input.reviewGate
      ? "Merging refused because automated review is not approved; awaiting structured AgentOS-Human-Decision."
      : "The merge shepherd could not safely merge this issue.",
    "",
    input.prUrl ? `- PR: ${input.prUrl}` : null,
    `- Reason: ${input.reason}`,
    input.reviewGate ? "- Decision format: [WORKFLOW.md Human Decision Re-Entry](WORKFLOW.md#human-decision-re-entry)" : null,
    "",
    input.reviewGate
      ? "Record a structured `AgentOS-Human-Decision` before returning this issue to `Merging`."
      : input.route === "running" && input.targetState
        ? `AgentOS moved this issue back to \`${input.targetState}\` for repair. Move it back to \`Merging\` when ready.`
        : "Please resolve the issue and move it back to `Merging` when ready."
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function mergeFailureActiveRepairRoute(reason: string): MergeFailureRoute | undefined {
  return /checks?.*(fail|failing|present|successful)|not mergeable|merge conflicts?|branch protection|required checks?|merge queue|protected branch/i.test(reason)
    ? "running"
    : undefined;
}

export function mergeFailureActiveRepairStatePatch(reason: string, current: Pick<IssueState, "reviewStatus"> | null | undefined): Partial<IssueState> {
  return {
    phase: "fix",
    reviewStatus: current?.reviewStatus ? "changes_requested" : undefined,
    lifecycleStatus: undefined,
    lastError: reason,
    errorCategory: categorizeRunError(reason),
    activeRunId: undefined,
    nextRetryAt: undefined,
    retryAttempt: undefined,
    stopReason: `merge shepherd returned issue to active repair: ${reason}`
  };
}
