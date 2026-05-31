import { GitHubClient, summarizeFeedback, type PullRequestStatus } from "./github.js";
import { readGitHubReviewContext } from "./github-context.js";
import { assertPullRequestUrlMatchesRepo } from "./github-repository.js";
import { pullRequestContextEntriesForUrls, pullRequestRefsForUrls, type PullRequestContextEntry } from "./context-pack.js";
import { safeGuardrailErrorMessage } from "./orchestrator-guardrail-errors.js";
import { mergeTargetPullRequest } from "./issue-state.js";
import { uniqueStrings } from "./orchestrator-state-helpers.js";
import type { Issue, IssueState, ServiceConfig } from "./types.js";

export interface PullRequestInspectionLogger {
  write(entry: { type: string; issueId?: string; issueIdentifier?: string; message: string; payload?: unknown }): Promise<unknown>;
}

export async function alreadyMergedPullRequestStatus(input: {
  state: IssueState | null;
  config: ServiceConfig;
  repoRoot: string;
  logger: PullRequestInspectionLogger;
}): Promise<PullRequestStatus | null> {
  const urls = uniqueStrings([mergeTargetPullRequest(input.state)?.url].filter((url): url is string => Boolean(url)));
  if (urls.length === 0) return null;
  const github = new GitHubClient(input.config.github.command);
  for (const url of urls) {
    const targetMatchesRepo = await assertPullRequestUrlMatchesRepo(input.repoRoot, url).then(
      () => true,
      async (error: unknown) => {
        const message = safeGuardrailErrorMessage(error);
        await input.logger.write({
          type: "github_status_warning",
          message: `skipping off-repository PR merge-state read for ${url}: ${message}`
        });
        return false;
      }
    );
    if (!targetMatchesRepo) continue;
    const status = await github.getPullRequest(url, input.repoRoot).catch(async (error: Error) => {
      const message = safeGuardrailErrorMessage(error);
      await input.logger.write({
        type: "github_status_warning",
        message: `could not read PR merge state for ${url}: ${message}`
      });
      return null;
    });
    if (status?.merged) return status;
  }
  return null;
}

export async function githubFeedbackSummary(input: {
  prUrl: string;
  config: ServiceConfig;
  repoRoot: string;
}): Promise<string> {
  const github = new GitHubClient(input.config.github.command);
  const status = await github.getPullRequest(input.prUrl, input.repoRoot);
  const threads = await github.getPullRequestReviewThreads(input.prUrl, input.repoRoot).catch(() => []);
  return summarizeFeedback(status, threads);
}

export async function pullRequestReentryContext(input: {
  issue: Issue;
  state: IssueState | null;
  existingPr: string | null;
  config: ServiceConfig;
  repoRoot: string;
}): Promise<{ pullRequests: PullRequestContextEntry[]; feedback: string | null }> {
  const { existingPr, issue, state } = input;
  if (!existingPr) return { pullRequests: [], feedback: null };
  if (issue.state.toLowerCase() !== "todo") {
    return { pullRequests: pullRequestContextEntriesForUrls(state, [existingPr]), feedback: null };
  }

  const refs = pullRequestRefsForUrls(state, [existingPr]);
  const githubContext = await readGitHubReviewContext(refs, { githubCommand: input.config.github.command, repoRoot: input.repoRoot }).catch(() => null);
  if (githubContext) return { pullRequests: githubContext.entries, feedback: githubContext.feedback || null };

  const feedback = await githubFeedbackSummary({
    prUrl: existingPr,
    config: input.config,
    repoRoot: input.repoRoot
  }).catch((error: Error) => `Could not fetch GitHub feedback: ${error.message}`);
  return { pullRequests: pullRequestContextEntriesForUrls(state, [existingPr]), feedback };
}
