import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

export interface GitHubPullRequestRef extends GitHubRepositoryRef {
  number: string;
}

export async function assertPullRequestUrlMatchesRepo(repoRoot: string, url: string): Promise<void> {
  const parsed = parseGitHubPullRequestUrl(url);
  const repo = await currentGitHubRepository(repoRoot);
  if (!sameGitHubRepository(parsed, repo)) {
    throw new Error(`pull request URL must belong to current repository ${repo.owner}/${repo.repo}: ${url}`);
  }
}

export async function assertPullRequestUrlsMatchRepo(repoRoot: string, urls: string[]): Promise<void> {
  for (const url of urls) {
    await assertPullRequestUrlMatchesRepo(repoRoot, url);
  }
}

export function parseGitHubPullRequestUrl(url: string): GitHubPullRequestRef {
  const match = url.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)$/);
  if (!match) {
    throw new Error(`invalid_github_pull_request_url: ${url}`);
  }
  return { owner: match[1], repo: match[2], number: match[3] };
}

export async function currentGitHubRepository(repoRoot: string): Promise<GitHubRepositoryRef> {
  let remote = "";
  try {
    const result = await execFileAsync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { encoding: "utf8" });
    remote = result.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`current repository remote origin is required for PR URL validation: ${message}`);
  }
  const parsed = parseGitHubRemote(remote);
  if (!parsed) {
    throw new Error(`unsupported_github_remote_origin: ${remote}`);
  }
  return parsed;
}

export function parseGitHubRemote(remote: string): GitHubRepositoryRef | null {
  const https = remote.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = remote.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

export function sameGitHubRepository(a: GitHubRepositoryRef, b: GitHubRepositoryRef): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
}
