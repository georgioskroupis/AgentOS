import { landingFreshnessPatch } from "./landing-preflight.js";
import type { GitHubClient, PullRequestStatus } from "./github.js";
import type { JsonlLogger } from "./logging.js";
import type { Issue, IssueState } from "./types.js";

export async function markDraftPullRequestReadyIfConfigured(input: {
  issue: Issue;
  github: GitHubClient;
  repoRoot: string;
  pr: PullRequestStatus;
  prUrl: string;
  state: IssueState;
  requireChecks: boolean;
  markDraftReady?: boolean;
  reason: string;
  recordIssueState: (issue: Issue, patch: Partial<IssueState>) => Promise<IssueState>;
  commentIssue: (issue: Issue, body: string, key?: string) => Promise<void>;
  logger: Pick<JsonlLogger, "write">;
}): Promise<PullRequestStatus> {
  if (!input.pr.isDraft) return input.pr;
  if (!input.markDraftReady) return input.pr;

  const beforeHeadSha = input.pr.headSha ?? null;
  await input.github.markPullRequestReady(input.prUrl, input.repoRoot);
  const refreshed = await input.github.getPullRequest(input.prUrl, input.repoRoot);
  const markedAt = new Date().toISOString();
  await input.recordIssueState(input.issue, {
    ...landingFreshnessPatch(input.state, refreshed, input.requireChecks),
    pullRequestReady: {
      status: "marked_ready",
      prUrl: input.prUrl,
      markedAt,
      beforeHeadSha,
      afterHeadSha: refreshed.headSha ?? null,
      reason: input.reason
    },
    updatedAt: markedAt
  });
  await input.commentIssue(
    input.issue,
    [
      "### AgentOS PR ready",
      "",
      "AgentOS marked the draft pull request ready after landing preflight passed.",
      "",
      `- PR: ${input.prUrl}`,
      beforeHeadSha ? `- Head before ready: ${beforeHeadSha}` : null,
      refreshed.headSha ? `- Head after ready: ${refreshed.headSha}` : null,
      `- Reason: ${input.reason}`
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    "pr_ready"
  );
  await input.logger.write({
    type: "pull_request_marked_ready",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: input.prUrl,
    payload: { prUrl: input.prUrl, beforeHeadSha, afterHeadSha: refreshed.headSha ?? null, reason: input.reason }
  });
  return refreshed;
}
