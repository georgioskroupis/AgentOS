import { resolve } from "node:path";
import type { GitHubClient, PullRequestStatus } from "./github.js";
import type { JsonlLogger } from "./logging.js";
import type { Issue, ServiceConfig } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

export async function cleanupMergedPullRequest(input: {
  issue: Issue;
  github: GitHubClient;
  pullRequest: PullRequestStatus;
  config: ServiceConfig;
  repoRoot: string;
  logger: Pick<JsonlLogger, "write">;
}): Promise<string[]> {
  const warnings: string[] = [];
  const workspaceManager = new WorkspaceManager(input.config, resolve(input.repoRoot));
  await workspaceManager.remove(input.issue.identifier).catch((error: Error) => {
    warnings.push(`Workspace cleanup failed for ${input.issue.identifier}: ${error.message}`);
  });
  const cleanup = await input.github.cleanupMergedPullRequest(input.pullRequest, input.config.github, resolve(input.repoRoot));
  warnings.push(...cleanup.warnings);
  if (warnings.length > 0) {
    await input.logger.write({
      type: "merge_cleanup_warning",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: warnings.join("; "),
      payload: { warnings }
    });
  }
  return warnings;
}
