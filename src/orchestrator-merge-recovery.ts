import { mergeEligiblePullRequests, mergeTargetPullRequest, pullRequestUrls } from "./issue-state.js";
import type { JsonlLogger } from "./logging.js";
import { isNoPrHandoffApproved } from "./orchestrator-state-helpers.js";
import { OperatorRecoveryRefusal, recordOperatorRecovery } from "./recovery.js";
import type { Issue, IssueState } from "./types.js";

export interface MergeMetadataRecoveryResult {
  state: IssueState | null;
  refusal: OperatorRecoveryRefusal | null;
}

export async function recoverMergeMetadataFromWorkspaceEvidence(input: {
  issue: Issue;
  state: IssueState | null;
  repoRoot: string;
  logger: JsonlLogger;
}): Promise<MergeMetadataRecoveryResult> {
  if (mergeTargetPullRequest(input.state) || mergeEligiblePullRequests(input.state).length > 0 || (input.state && isNoPrHandoffApproved(input.state))) {
    return { state: input.state, refusal: null };
  }

  try {
    const result = await recordOperatorRecovery({
      repoRoot: input.repoRoot,
      issueIdentifier: input.issue.identifier,
      ...(input.state?.workspacePath ? { workspacePath: input.state.workspacePath } : {})
    });
    await input.logger.write({
      type: "merge_recovery_recorded",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: "reconstructed merge metadata from workspace handoff and validation evidence",
      payload: { prUrls: pullRequestUrls(result.state), handoffPath: result.handoffPath, validationPath: result.validationPath }
    });
    return { state: result.state, refusal: null };
  } catch (error) {
    if (error instanceof OperatorRecoveryRefusal) {
      await input.logger.write({
        type: "merge_recovery_skipped",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        message: error.message
      });
      return { state: input.state, refusal: error };
    }
    throw error;
  }
}
