import { branchFreshnessCommentBody, planBranchFreshnessUpdate } from "./branch-update.js";
import { landingFreshnessPatch } from "./landing-preflight.js";
import type { GitHubClient, PullRequestStatus } from "./github.js";
import type { JsonlLogger } from "./logging.js";
import type { IssueStateStore } from "./issue-state.js";
import type { Issue, IssueState, ServiceConfig } from "./types.js";

export type MergeBranchFreshnessResult =
  | { action: "none"; state: IssueState }
  | {
      action: "waiting" | "failed";
      state: IssueState;
      reason: string;
      timingLabel: string;
      timingStatus: "waiting" | "failed";
      timingMetadata: Record<string, unknown>;
    };

export async function handleMergeBranchFreshness(input: {
  config: ServiceConfig;
  github: GitHubClient;
  repoRoot: string;
  issue: Issue;
  state: IssueState;
  stateStore: Pick<IssueStateStore, "merge">;
  pullRequest: PullRequestStatus;
  prUrl: string;
  logger: Pick<JsonlLogger, "write">;
  commentIssue: (body: string, key?: string) => Promise<void>;
}): Promise<MergeBranchFreshnessResult> {
  const plan = planBranchFreshnessUpdate(input.config, input.pullRequest);
  if (plan.action === "none") return { action: "none", state: input.state };

  await input.commentIssue(branchFreshnessCommentBody(input.prUrl, input.pullRequest, plan), "branch_freshness");
  if (plan.action === "report-only") {
    const state = await input.stateStore.merge(input.issue.identifier, {
      ...input.state,
      branchUpdate: {
        status: "report_only",
        updatedAt: new Date().toISOString(),
        prUrl: input.prUrl,
        reason: plan.reason,
        operatorGuidance: plan.operatorGuidance,
        mergeStateStatus: plan.mergeStateStatus,
        beforeHeadSha: input.pullRequest.headSha ?? null
      },
      updatedAt: new Date().toISOString()
    });
    return {
      action: "failed",
      state,
      reason: plan.reason,
      timingStatus: "failed",
      timingLabel: "merge shepherding failed",
      timingMetadata: { prUrl: input.prUrl, reason: plan.reason, branchFreshness: "report-only" }
    };
  }

  const beforeHeadSha = input.pullRequest.headSha ?? null;
  await input.github.updatePullRequestBranch(input.prUrl, input.repoRoot);
  const refreshedPr = await input.github.getPullRequest(input.prUrl, input.repoRoot);
  const state = await input.stateStore.merge(input.issue.identifier, {
    ...input.state,
    ...landingFreshnessPatch(input.state, refreshedPr, input.config.github.requireChecks),
    branchUpdate: {
      status: "updated",
      updatedAt: new Date().toISOString(),
      prUrl: input.prUrl,
      reason: plan.reason,
      operatorGuidance: plan.operatorGuidance,
      mergeStateStatus: plan.mergeStateStatus,
      beforeHeadSha,
      afterHeadSha: refreshedPr.headSha ?? null
    },
    stopReason: "stale PR branch updated; refresh GitHub checks and validation evidence before merge progression",
    updatedAt: new Date().toISOString()
  });
  const reason = "stale PR branch was updated; wait for fresh GitHub checks and validation evidence before merging";
  await input.logger.write({
    type: "branch_update_requested",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: reason,
    payload: { prUrl: input.prUrl, beforeHeadSha, afterHeadSha: refreshedPr.headSha ?? null, mergeStateStatus: plan.mergeStateStatus }
  });
  return {
    action: "waiting",
    state,
    reason,
    timingStatus: "waiting",
    timingLabel: "merge shepherding waiting on branch update",
    timingMetadata: { prUrl: input.prUrl, reason, beforeHeadSha, afterHeadSha: refreshedPr.headSha ?? null }
  };
}
