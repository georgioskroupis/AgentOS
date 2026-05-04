import { spawn } from "node:child_process";
import { redactText } from "./redaction.js";
import type { ServiceConfig } from "./types.js";

export interface PullRequestStatus {
  url: string;
  state: string;
  isDraft: boolean;
  mergeable: string | null;
  baseRefName: string | null;
  headRefName: string | null;
  headSha: string | null;
  merged: boolean;
  checkSummary: CheckSummary;
  checkDetails: CheckDetail[];
  changedFiles: string[];
  reviewDecision: string | null;
  latestReviews: PullRequestReview[];
  comments: PullRequestComment[];
}

export interface CheckSummary {
  total: number;
  successful: number;
  pending: number;
  failing: number;
}

export interface CheckDetail {
  name: string;
  status: string | null;
  conclusion: string | null;
  state?: string | null;
  url: string | null;
}

export interface CheckDiagnostic {
  check: CheckDetail;
  classification: "mechanical" | "human_required";
  reason: string;
  /** Sanitized, bounded, untrusted CI output excerpt. */
  log: string | null;
}

export interface PullRequestReview {
  author: string | null;
  state: string;
  body: string | null;
  submittedAt: string | null;
}

export interface PullRequestComment {
  author: string | null;
  body: string;
  createdAt: string | null;
}

export interface ReviewThread {
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: PullRequestComment[];
}

export interface MergeReadiness {
  ready: boolean;
  reason: string;
}

export class GitHubClient {
  constructor(private readonly command = "gh") {}

  async getPullRequest(url: string, cwd: string): Promise<PullRequestStatus> {
    const raw = await runShell(
      `${this.command} pr view ${shellQuote(url)} --json url,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,mergedAt,statusCheckRollup,changedFiles,files,reviewDecision,latestReviews,reviews,comments`,
      cwd
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rollup = Array.isArray(parsed.statusCheckRollup) ? parsed.statusCheckRollup : [];
    return {
      url: String(parsed.url ?? url),
      state: String(parsed.state ?? ""),
      isDraft: Boolean(parsed.isDraft),
      mergeable: typeof parsed.mergeable === "string" ? parsed.mergeable : null,
      baseRefName: typeof parsed.baseRefName === "string" ? parsed.baseRefName : null,
      headRefName: typeof parsed.headRefName === "string" ? parsed.headRefName : null,
      headSha: typeof parsed.headRefOid === "string" ? parsed.headRefOid : null,
      merged: Boolean(parsed.mergedAt) || String(parsed.state ?? "").toUpperCase() === "MERGED",
      checkSummary: summarizeChecks(rollup),
      checkDetails: summarizeCheckDetails(rollup),
      changedFiles: changedFileNames(parsed.files),
      reviewDecision: typeof parsed.reviewDecision === "string" ? parsed.reviewDecision : null,
      latestReviews: pullRequestReviews(Array.isArray(parsed.latestReviews) ? parsed.latestReviews : Array.isArray(parsed.reviews) ? parsed.reviews : []),
      comments: pullRequestComments(Array.isArray(parsed.comments) ? parsed.comments : [])
    };
  }

  async mergePullRequest(url: string, config: ServiceConfig["github"], cwd: string): Promise<void> {
    const methodFlag = config.mergeMethod === "merge" ? "--merge" : config.mergeMethod === "rebase" ? "--rebase" : "--squash";
    const deleteFlag = config.deleteBranch ? " --delete-branch" : "";
    await runShell(`${this.command} pr merge ${shellQuote(url)} ${methodFlag}${deleteFlag}`, cwd);
  }

  async getPullRequestDiff(url: string, cwd: string): Promise<string> {
    return runShell(`${this.command} pr diff ${shellQuote(url)}`, cwd);
  }

  async getPullRequestReviewThreads(url: string, cwd: string): Promise<ReviewThread[]> {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return [];
    const [, owner, repo, number] = match;
    const query = `
      query AgentOSReviewThreads($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                path
                line
                comments(first: 20) {
                  nodes {
                    body
                    createdAt
                    author { login }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const raw = await runShell(
      `${this.command} api graphql -f query=${shellQuote(query)} -F owner=${shellQuote(owner)} -F repo=${shellQuote(repo)} -F number=${shellQuote(number)}`,
      cwd
    );
    const parsed = JSON.parse(raw) as Record<string, any>;
    const nodes = parsed.data?.repository?.pullRequest?.reviewThreads?.nodes;
    if (!Array.isArray(nodes)) return [];
    return nodes.map((node: Record<string, any>) => ({
      path: typeof node.path === "string" ? node.path : null,
      line: typeof node.line === "number" ? node.line : null,
      isResolved: Boolean(node.isResolved),
      comments: pullRequestComments(Array.isArray(node.comments?.nodes) ? node.comments.nodes : [])
    }));
  }

  async getFailingCheckDiagnostics(status: PullRequestStatus, cwd: string): Promise<CheckDiagnostic[]> {
    const failing = status.checkDetails.filter((check) => checkDetailState(check) === "failing");
    if (status.checkSummary.failing > 0 && failing.length === 0) {
      return [
        {
          check: {
            name: "unknown failing check",
            status: null,
            conclusion: "FAILURE",
            url: null
          },
          classification: "human_required",
          reason: "GitHub reported failing checks, but no check details were available.",
          log: null
        }
      ];
    }
    return Promise.all(failing.map((check) => this.getCheckDiagnostic(check, status, cwd)));
  }

  private async getCheckDiagnostic(check: CheckDetail, status: PullRequestStatus, cwd: string): Promise<CheckDiagnostic> {
    const run = githubActionsRunId(check.url, githubRepositoryFromPullRequestUrl(status.url));
    if (!run.runId) {
      return {
        check,
        classification: "human_required",
        reason: run.reason,
        log: null
      };
    }
    const verification = await this.verifyActionsRunForPullRequest(run.runId, status, cwd);
    if (!verification.ok) {
      return {
        check,
        classification: "human_required",
        reason: verification.reason,
        log: null
      };
    }
    try {
      const log = await runShell(`${this.command} run view ${shellQuote(run.runId)} --log-failed`, cwd);
      const classification = classifyCiFailureLog(log);
      return {
        check,
        classification: classification.mechanical ? "mechanical" : "human_required",
        reason: classification.reason,
        log: sanitizeCiLog(log)
      };
    } catch (error) {
      return {
        check,
        classification: "human_required",
        reason: diagnosticErrorReason("Could not read failed check logs", error),
        log: null
      };
    }
  }

  private async verifyActionsRunForPullRequest(runId: string, status: PullRequestStatus, cwd: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!status.headSha) {
      return { ok: false, reason: "Could not verify the reviewed pull request head SHA before reading failed check logs." };
    }
    try {
      const raw = await runShell(`${this.command} run view ${shellQuote(runId)} --json headSha`, cwd);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const headSha = typeof parsed.headSha === "string" ? parsed.headSha : null;
      if (!headSha) {
        return { ok: false, reason: "Could not verify the failed GitHub Actions run head SHA before reading logs." };
      }
      if (headSha.toLowerCase() !== status.headSha.toLowerCase()) {
        return { ok: false, reason: "The failed GitHub Actions run does not match the reviewed pull request head SHA." };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: diagnosticErrorReason("Could not verify the failed GitHub Actions run before reading logs", error) };
    }
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
    summary[classifyCheckState(item as CheckStateInput)] += 1;
  }
  return summary;
}

export function summarizeCheckDetails(items: unknown[]): CheckDetail[] {
  return items.map((item) => {
    const raw = item as Record<string, any>;
    return {
      name: String(raw.name ?? raw.context ?? raw.workflowName ?? "unknown"),
      status: raw.status == null ? null : String(raw.status),
      conclusion: raw.conclusion == null ? null : String(raw.conclusion),
      state: raw.state == null ? null : String(raw.state),
      url:
        typeof raw.detailsUrl === "string"
          ? raw.detailsUrl
          : typeof raw.targetUrl === "string"
            ? raw.targetUrl
            : typeof raw.url === "string"
              ? raw.url
              : null
    };
  });
}

export function summarizePullRequestForPrompt(status: PullRequestStatus, diff: string, threads: ReviewThread[] = [], diagnostics: CheckDiagnostic[] = []): string {
  const checks = status.checkDetails.length
    ? status.checkDetails.map((check) => `- ${check.name}: ${check.status ?? check.state ?? "unknown"} / ${check.conclusion ?? "unknown"}${check.url ? ` (${check.url})` : ""}`).join("\n")
    : "- No checks reported.";
  const checkDiagnostics = diagnostics.length ? summarizeCheckDiagnostics(diagnostics) : "- No failed check diagnostics reported.";
  const reviews = status.latestReviews.length
    ? status.latestReviews.map((review) => `- ${review.author ?? "unknown"}: ${review.state}${review.body ? ` - ${firstLine(review.body)}` : ""}`).join("\n")
    : "- No reviews reported.";
  const comments = status.comments.length
    ? status.comments.slice(-10).map((comment) => `- ${comment.author ?? "unknown"}: ${firstLine(comment.body)}`).join("\n")
    : "- No PR comments reported.";
  const unresolved = threads.filter((thread) => !thread.isResolved);
  const threadSummary = unresolved.length
    ? unresolved.map((thread) => `- ${thread.path ?? "unknown"}${thread.line ? `:${thread.line}` : ""}: ${thread.comments.map((comment) => firstLine(comment.body)).join(" | ")}`).join("\n")
    : "- No unresolved review threads reported.";
  return [
    `State: ${status.state}`,
    `Draft: ${status.isDraft ? "yes" : "no"}`,
    `Mergeable: ${status.mergeable ?? "unknown"}`,
    `Base: ${status.baseRefName ?? "unknown"}`,
    `Head: ${status.headRefName ?? "unknown"} ${status.headSha ?? ""}`.trim(),
    `Review decision: ${status.reviewDecision ?? "unknown"}`,
    `Changed files: ${status.changedFiles.length ? status.changedFiles.join(", ") : "unknown"}`,
    "",
    "Checks:",
    checks,
    "",
    "Failed check diagnostics:",
    checkDiagnostics,
    "",
    "Latest reviews:",
    reviews,
    "",
    "PR comments:",
    comments,
    "",
    "Unresolved review threads:",
    threadSummary,
    "",
    "Diff:",
    diff.slice(0, 60_000)
  ].join("\n");
}

export function summarizeCheckDiagnostics(diagnostics: CheckDiagnostic[]): string {
  if (diagnostics.length === 0) return "- No failing check diagnostics.";
  return diagnostics
    .map((diagnostic) => {
      const log = diagnostic.log ? `\n  Log excerpt (sanitized, untrusted): ${singleLine(diagnostic.log).slice(0, 1200)}` : "";
      return `- ${diagnostic.check.name}: ${diagnostic.classification} - ${sanitizeDiagnosticText(diagnostic.reason, 800)}${log}`;
    })
    .join("\n");
}

export function summarizeFeedback(status: PullRequestStatus, threads: ReviewThread[] = []): string {
  const comments = status.comments.map((comment) => `PR comment by ${comment.author ?? "unknown"}: ${firstLine(comment.body)}`);
  const reviews = status.latestReviews.map((review) => `Review by ${review.author ?? "unknown"} (${review.state}): ${review.body ? firstLine(review.body) : "no body"}`);
  const unresolved = threads
    .filter((thread) => !thread.isResolved)
    .flatMap((thread) => thread.comments.map((comment) => `Unresolved ${thread.path ?? "unknown"}${thread.line ? `:${thread.line}` : ""}: ${firstLine(comment.body)}`));
  return [...reviews, ...comments, ...unresolved].slice(-30).join("\n");
}

function changedFileNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const raw = item as Record<string, unknown>;
      return typeof raw.path === "string" ? raw.path : typeof raw.filename === "string" ? raw.filename : null;
    })
    .filter((item): item is string => Boolean(item));
}

type CheckState = "successful" | "pending" | "failing";

interface CheckStateInput {
  status?: unknown;
  conclusion?: unknown;
  state?: unknown;
}

function classifyCheckState(check: CheckStateInput): CheckState {
  const conclusion = String(check.conclusion ?? check.state ?? "").toUpperCase();
  const status = String(check.status ?? "").toUpperCase();
  if (conclusion === "SUCCESS" || conclusion === "SUCCESSFUL") return "successful";
  if (status && status !== "COMPLETED") return "pending";
  if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS"].includes(conclusion)) return "pending";
  return "failing";
}

function checkDetailState(check: CheckDetail): CheckState {
  return classifyCheckState(check);
}

interface GitHubRepositoryRef {
  owner: string;
  repo: string;
}

function githubRepositoryFromPullRequestUrl(url: string): GitHubRepositoryRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const [owner, repo, pull, number] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo || pull !== "pull" || !number) return null;
  return { owner, repo };
}

function githubActionsRunId(url: string | null, repository: GitHubRepositoryRef | null): { runId: string | null; reason: string } {
  if (!url) {
    return { runId: null, reason: "No GitHub Actions run URL was available for the failing check." };
  }
  if (!repository) {
    return { runId: null, reason: "Could not verify the reviewed pull request repository before reading failed check logs." };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { runId: null, reason: "The failing check URL was not a valid GitHub Actions run URL for the reviewed pull request repository." };
  }
  const [owner, repo, actions, runs, runId] = parsed.pathname.split("/").filter(Boolean);
  const sameRepository = owner?.toLowerCase() === repository.owner.toLowerCase() && repo?.toLowerCase() === repository.repo.toLowerCase();
  if (parsed.hostname.toLowerCase() !== "github.com" || !sameRepository || actions !== "actions" || runs !== "runs" || !/^\d+$/.test(runId ?? "")) {
    return { runId: null, reason: "The failing check URL was not a GitHub Actions run URL for the reviewed pull request repository." };
  }
  return { runId, reason: "GitHub Actions run URL verified for the reviewed pull request repository." };
}

function sanitizeCiLog(log: string): string | null {
  const sanitized = redactText(log).trim();
  if (!sanitized) return null;
  return sanitized.slice(0, 4000);
}

function diagnosticErrorReason(prefix: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutCommand = raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*command_failed:/i.test(line))
    .join("\n");
  const details = sanitizeDiagnosticText(withoutCommand, 500);
  if (!details) {
    return `${prefix}. GitHub CLI error details were unavailable after sanitization.`;
  }
  return `${prefix}: ${details}`;
}

function sanitizeDiagnosticText(value: string, maxLength: number): string {
  return singleLine(redactText(value)).slice(0, maxLength).trim();
}

function classifyCiFailureLog(log: string): { mechanical: boolean; reason: string } {
  const text = log.trim();
  if (!text) {
    return { mechanical: false, reason: "The failed check did not expose logs." };
  }
  if (
    /ambiguous|unclear requirement|human judgment|manual approval|requires approval|user input|approval request|elicitation|permission denied|resource not accessible|authentication|authorization|missing secret/i.test(
      text
    )
  ) {
    return { mechanical: false, reason: "The failed check logs point to missing access, denied input, or ambiguous requirements." };
  }
  if (
    /npm run agent-check|npm test|vitest|test failed|tests failed|assertionerror|expected .* received|error TS\d+|typescript|tsc\b|eslint|prettier|lint|syntaxerror|typeerror|referenceerror|build failed|command failed/i.test(
      text
    )
  ) {
    return { mechanical: true, reason: "Failed check logs contain deterministic build, typecheck, lint, or test output." };
  }
  return { mechanical: false, reason: "The failed check logs were present, but AgentOS could not classify the failure as mechanical." };
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function pullRequestReviews(items: unknown[]): PullRequestReview[] {
  return items.map((item) => {
    const raw = item as Record<string, any>;
    return {
      author: typeof raw.author?.login === "string" ? raw.author.login : typeof raw.author === "string" ? raw.author : null,
      state: String(raw.state ?? ""),
      body: typeof raw.body === "string" ? raw.body : null,
      submittedAt: typeof raw.submittedAt === "string" ? raw.submittedAt : null
    };
  });
}

function pullRequestComments(items: unknown[]): PullRequestComment[] {
  return items.map((item) => {
    const raw = item as Record<string, any>;
    return {
      author: typeof raw.author?.login === "string" ? raw.author.login : typeof raw.author === "string" ? raw.author : null,
      body: String(raw.body ?? ""),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null
    };
  });
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0]?.slice(0, 240) ?? "";
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
