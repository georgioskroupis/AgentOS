import { spawn } from "node:child_process";
import type { ServiceConfig } from "./types.js";

export interface PullRequestStatus {
  url: string;
  state: string;
  isDraft: boolean;
  mergeable: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  merged: boolean;
  checkSummary: CheckSummary;
}

export interface CheckSummary {
  total: number;
  successful: number;
  pending: number;
  failing: number;
}

export interface MergeReadiness {
  ready: boolean;
  reason: string;
}

export class GitHubClient {
  constructor(private readonly command = "gh") {}

  async getPullRequest(url: string, cwd: string): Promise<PullRequestStatus> {
    const raw = await runShell(
      `${this.command} pr view ${shellQuote(url)} --json url,state,isDraft,mergeable,baseRefName,headRefName,mergedAt,statusCheckRollup`,
      cwd
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      url: String(parsed.url ?? url),
      state: String(parsed.state ?? ""),
      isDraft: Boolean(parsed.isDraft),
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : null,
      baseRefName: typeof parsed.baseRefName === "string" ? parsed.baseRefName : null,
      headRefName: typeof parsed.headRefName === "string" ? parsed.headRefName : null,
      merged: Boolean(parsed.mergedAt) || String(parsed.state ?? "").toUpperCase() === "MERGED",
      checkSummary: summarizeChecks(Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [])
    };
  }

  async mergePullRequest(url: string, config: ServiceConfig["github"], cwd: string): Promise<void> {
    const methodFlag = config.mergeMethod === "merge" ? "--merge" : config.mergeMethod === "rebase" ? "--rebase" : "--squash";
    const deleteFlag = config.deleteBranch ? " --delete-branch" : "";
    await runShell(`${this.command} pr merge ${shellQuote(url)} ${methodFlag}${deleteFlag}`, cwd);
  }
}

export async function verifyGitHubCli(command = "gh", cwd = process.cwd()): Promise<{ ok: boolean; details: string }> {
  try {
    const details = await runShell(`${command} auth status`, cwd);
    return { ok: true, details };
  } catch (error) {
    return { ok: false, details: error instanceof Error ? error.message : String(error) };
  }
}

export function evaluateMergeReadiness(status: PullRequestStatus, requireChecks: boolean): MergeReadiness {
  if (status.merged) return { ready: false, reason: "pull request is already merged" };
  if (status.state && status.state.toUpperCase() !== "OPEN") return { ready: false, reason: `pull request is ${status.state}` };
  if (status.isDraft) return { ready: false, reason: "pull request is still a draft" };
  if (status.mergeable && status.mergeable.toUpperCase() !== "MERGEABLE") {
    return { ready: false, reason: `pull request is not mergeable (${status.mergeable})` };
  }
  if (requireChecks && status.checkSummary.total === 0) {
    return { ready: false, reason: "no GitHub checks are present" };
  }
  if (status.checkSummary.failing > 0) {
    return { ready: false, reason: `${status.checkSummary.failing} GitHub check(s) failed` };
  }
  if (status.checkSummary.pending > 0) {
    return { ready: false, reason: `${status.checkSummary.pending} GitHub check(s) still pending` };
  }
  if (requireChecks && status.checkSummary.successful === 0) {
    return { ready: false, reason: "no successful GitHub checks are present" };
  }
  return { ready: true, reason: "ready to merge" };
}

export function summarizeChecks(items: unknown[]): CheckSummary {
  const summary: CheckSummary = { total: items.length, successful: 0, pending: 0, failing: 0 };
  for (const item of items) {
    const raw = item as Record<string, unknown>;
    const conclusion = String(raw.conclusion ?? raw.state ?? "").toUpperCase();
    const status = String(raw.status ?? "").toUpperCase();
    if (conclusion === "SUCCESS" || conclusion === "SUCCESSFUL") {
      summary.successful += 1;
    } else if (status && status !== "COMPLETED") {
      summary.pending += 1;
    } else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"].includes(conclusion)) {
      summary.pending += 1;
    } else {
      summary.failing += 1;
    }
  }
  return summary;
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `command_failed: ${command}`));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
