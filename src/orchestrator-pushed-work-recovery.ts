import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { GitHubClient, type PullRequestStatus } from "./github.js";
import { recordOperatorRecovery, type WorkspaceRecoveryDiagnostics } from "./recovery.js";
import { workspaceKey } from "./workspace.js";
import type { JsonlLogger } from "./logging.js";
import type { Issue, IssueState, Workspace } from "./types.js";

export interface AutoRecoverPushedWorkInput {
  issue: Issue;
  recovery: WorkspaceRecoveryDiagnostics;
  reason: string;
  repoRoot: string;
  githubCommand: string;
  logger: JsonlLogger;
  markSucceeded: (workspace: Workspace, handoff: string | null, state: IssueState) => Promise<void>;
}

export async function autoRecoverPushedWork(input: AutoRecoverPushedWorkInput): Promise<boolean> {
  const { issue, recovery } = input;
  if (!recovery.exists || !recovery.branch || !recovery.headSha || !recovery.cleanPushedWork) return false;

  const repoRoot = resolve(input.repoRoot);
  const handoffPath = join(recovery.workspacePath, ".agent-os", `handoff-${issue.identifier}.md`);
  const handoffExists = await exists(handoffPath);
  const pullRequest = handoffExists ? null : await recoveryPullRequestForBranch(input.githubCommand, repoRoot, recovery).catch(() => null);
  if (!handoffExists && !pullRequest?.url) return false;
  if (pullRequest?.headSha && pullRequest.headSha.toLowerCase() !== recovery.headSha.toLowerCase()) {
    await input.logger.write({
      type: "pushed_work_recovery_skipped",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: "pull request head did not match clean pushed branch head",
      payload: { branch: recovery.branch, headSha: recovery.headSha, prUrl: pullRequest.url, prHeadSha: pullRequest.headSha }
    });
    return false;
  }

  try {
    const result = await recordOperatorRecovery({
      repoRoot,
      issueIdentifier: issue.identifier,
      workspacePath: recovery.workspacePath,
      syntheticHandoff: handoffExists ? undefined : { outcome: "implemented", pullRequestUrl: pullRequest?.url ?? null }
    });
    const handoff = await readText(resolve(repoRoot, result.handoffPath)).catch(() => null);
    await input.markSucceeded({ path: result.workspacePath, workspaceKey: workspaceKey(issue.identifier), createdNow: false }, handoff, result.state);
    await input.logger.write({
      type: "pushed_work_recovered",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: input.reason,
      payload: {
        branch: result.branch,
        headSha: result.headSha,
        handoffPath: result.handoffPath,
        validationPath: result.validationPath,
        prs: result.state.prs ?? []
      }
    });
    return true;
  } catch (error) {
    await input.logger.write({
      type: "pushed_work_recovery_skipped",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: error instanceof Error ? error.message : String(error),
      payload: { branch: recovery.branch, headSha: recovery.headSha }
    });
    return false;
  }
}

async function recoveryPullRequestForBranch(githubCommand: string, repoRoot: string, recovery: WorkspaceRecoveryDiagnostics): Promise<PullRequestStatus | null> {
  if (!recovery.branch) return null;
  const github = new GitHubClient(githubCommand);
  const pr = await github.getPullRequest(recovery.branch, repoRoot);
  return pr.state && pr.state.toUpperCase() !== "CLOSED" ? pr : null;
}
