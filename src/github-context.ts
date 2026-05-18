import { resolve } from "node:path";
import { GitHubClient, summarizeFeedback, summarizePullRequestForPrompt } from "./github.js";
import type { PullRequestRef } from "./types.js";

export interface GitHubReviewContextEntry {
  target: PullRequestRef;
  status: Awaited<ReturnType<GitHubClient["getPullRequest"]>>;
  checkDiagnostics: Awaited<ReturnType<GitHubClient["getCheckDiagnostics"]>>;
  diff: string;
  threads: Awaited<ReturnType<GitHubClient["getPullRequestReviewThreads"]>>;
}

export interface GitHubReviewContext {
  entries: GitHubReviewContextEntry[];
  summary: string;
  feedback: string;
}

export async function readGitHubReviewContext(targets: PullRequestRef[], input: { githubCommand: string; repoRoot: string }): Promise<GitHubReviewContext> {
  const github = new GitHubClient(input.githubCommand);
  const cwd = resolve(input.repoRoot);
  const entries: GitHubReviewContextEntry[] = [];
  const summaries: string[] = [];
  const feedback: string[] = [];
  for (const target of targets) {
    const status = await github.getPullRequest(target.url, cwd);
    const checkDiagnostics = await github.getCheckDiagnostics(status, cwd);
    const diff = await github.getPullRequestDiff(target.url, cwd).catch((error: Error) => `Could not fetch diff: ${error.message}`);
    const threads = await github.getPullRequestReviewThreads(target.url, cwd).catch(() => []);
    entries.push({ target, status, checkDiagnostics, diff, threads });
    summaries.push([`## PR ${target.url}`, `Role: ${target.role ?? "supporting"}`, summarizePullRequestForPrompt(status, diff, threads, checkDiagnostics)].join("\n"));
    const targetFeedback = summarizeFeedback(status, threads);
    if (targetFeedback) feedback.push([`## PR ${target.url}`, targetFeedback].join("\n"));
  }
  return { entries, summary: summaries.join("\n\n---\n\n"), feedback: feedback.join("\n\n---\n\n") };
}
