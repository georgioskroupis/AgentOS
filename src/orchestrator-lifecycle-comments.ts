import type { RetryEntry } from "./orchestrator-retry.js";
import type { Workspace } from "./types.js";

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
