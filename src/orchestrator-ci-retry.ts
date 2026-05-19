import { resolve } from "node:path";
import { ciRetryAttemptFromPlan, flakyCiRetryExhaustedFinding, flakyCiRetryUnhandledFinding, planFlakyCiRetry, type FlakyCiRetryPlan } from "./ci-retry.js";
import { GitHubClient, summarizeCheckDiagnostics, type PullRequestStatus } from "./github.js";
import type { GitHubReviewContextEntry } from "./github-context.js";
import type { JsonlLogger } from "./logging.js";
import { joinedHeadShas } from "./orchestrator-review-helpers.js";
import { summarizeText } from "./output-capture.js";
import type { CiRetryAttemptState, Issue, IssueState, ReviewFinding, ReviewTargetMode, ServiceConfig } from "./types.js";

export async function requestFlakyCiRetriesIfEligible(input: {
  issue: Issue;
  state: IssueState | null;
  entries: GitHubReviewContextEntry[];
  reviewTargetMode: ReviewTargetMode;
  runId?: string;
  config: ServiceConfig;
  repoRoot: string;
  logger: Pick<JsonlLogger, "write">;
  recordIssueState: (patch: Partial<IssueState>) => Promise<IssueState>;
  commentIssue: (body: string) => Promise<void>;
}): Promise<{ requested: boolean; terminalState: boolean; state: IssueState | null; findings: ReviewFinding[] }> {
  const plans = input.entries.map((entry) => ({
    entry,
    plan: planFlakyCiRetry({
      config: input.config,
      state: input.state,
      status: entry.status,
      diagnostics: entry.checkDiagnostics
    })
  }));
  const retryPlans = plans.filter((item) => item.plan.action === "retry");
  const exhaustedPlans = plans.filter((item) => item.plan.action === "exhausted");
  const exhaustedFindings = exhaustedPlans.map((item) => flakyCiRetryExhaustedFinding(item.plan, item.entry.status));
  const unhandledFindings = plans
    .filter((item) => item.plan.action === "skip")
    .map((item) => flakyCiRetryUnhandledFinding(item.plan, item.entry.status))
    .filter((finding): finding is ReviewFinding => Boolean(finding));
  if (retryPlans.length === 0 && exhaustedPlans.length > 0) {
    const attemptedAt = new Date().toISOString();
    const exhaustedAttempts = exhaustedPlans.map((item) =>
      ciRetryAttemptFromPlan({ plan: item.plan, status: item.entry.status, attemptedAt, statusValue: "exhausted" })
    );
    const nextState = await input.recordIssueState({
      phase: "review",
      reviewStatus: "pending",
      reviewTargetMode: input.reviewTargetMode,
      reviewTargetUrls: input.entries.map((target) => target.target.url),
      headSha: joinedHeadShas(input.entries),
      ciRetry: {
        status: "exhausted",
        updatedAt: attemptedAt,
        attempts: [...(input.state?.ciRetry?.attempts ?? []), ...exhaustedAttempts]
      }
    });
    await input.logger.write({
      type: "ci_flaky_retry_exhausted",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      runId: input.runId,
      message: exhaustedAttempts.map((attempt) => `${attempt.attempt}/${attempt.maxAttempts} ${attempt.checkNames.join(", ")}`).join("; "),
      payload: { attempts: exhaustedAttempts }
    });
    await input.commentIssue(flakyCiRetryExhaustedComment(exhaustedPlans.map((item) => ({ status: item.entry.status, plan: item.plan }))));
    return { requested: false, terminalState: false, state: nextState, findings: [...exhaustedFindings, ...unhandledFindings] };
  }
  if (retryPlans.length === 0) {
    return { requested: false, terminalState: false, state: input.state, findings: [...exhaustedFindings, ...unhandledFindings] };
  }

  const attemptedAt = new Date().toISOString();
  const github = new GitHubClient(input.config.github.command);
  const repoRoot = resolve(input.repoRoot);
  const attempts: CiRetryAttemptState[] = [];
  for (const { entry, plan } of retryPlans) {
    try {
      for (const run of plan.runIds) await github.rerunFailedActionsRun(run, repoRoot);
      attempts.push(ciRetryAttemptFromPlan({ plan, status: entry.status, attemptedAt, statusValue: "requested" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAttempt = ciRetryAttemptFromPlan({ plan, status: entry.status, attemptedAt, statusValue: "failed", error: summarizeText(message).inline });
      const nextState = await input.recordIssueState({
        phase: "review",
        reviewStatus: "human_required",
        reviewTargetMode: input.reviewTargetMode,
        reviewTargetUrls: input.entries.map((target) => target.target.url),
        headSha: joinedHeadShas(input.entries),
        ciRetry: {
          status: "failed",
          updatedAt: attemptedAt,
          attempts: [...(input.state?.ciRetry?.attempts ?? []), failedAttempt]
        },
        lastError: failedAttempt.error,
        errorCategory: "review"
      });
      await input.commentIssue(flakyCiRetryFailedComment(entry.status, plan, failedAttempt.error ?? "unknown rerun error"));
      await input.logger.write({
        type: "ci_flaky_retry_failed",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        message: failedAttempt.error ?? "unknown rerun error",
        payload: { prUrl: entry.status.url, runIds: plan.runIds, checkNames: plan.checkNames, attempt: plan.attempt, maxAttempts: plan.maxAttempts }
      });
      return { requested: false, terminalState: true, state: nextState, findings: [] };
    }
  }

  const ciRetry = {
    status: "requested" as const,
    updatedAt: attemptedAt,
    attempts: [...(input.state?.ciRetry?.attempts ?? []), ...attempts]
  };
  const nextState = await input.recordIssueState({
    phase: "review",
    reviewStatus: "pending",
    reviewTargetMode: input.reviewTargetMode,
    reviewTargetUrls: input.entries.map((target) => target.target.url),
    headSha: joinedHeadShas(input.entries),
    ciRetry,
    lastError: undefined,
    errorCategory: undefined,
    stopReason: "flaky CI retry requested; refresh GitHub check status before reviewer/fixer progression"
  });
  await input.commentIssue(flakyCiRetryRequestedComment(retryPlans.map((item) => ({ status: item.entry.status, plan: item.plan }))));
  await input.logger.write({
    type: "ci_flaky_retry_requested",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    runId: input.runId,
    message: attempts.map((attempt) => `${attempt.attempt}/${attempt.maxAttempts} ${attempt.checkNames.join(", ")}`).join("; "),
    payload: { attempts }
  });
  return { requested: true, terminalState: false, state: nextState, findings: [] };
}

function flakyCiRetryRequestedComment(items: Array<{ status: PullRequestStatus; plan: FlakyCiRetryPlan }>): string {
  return [
    "### AgentOS flaky CI retry requested",
    "",
    "AgentOS classified the failed check(s) as supported flaky/retryable GitHub Actions failures and requested bounded reruns of the failed jobs.",
    "",
    ...items.flatMap(({ status, plan }) => [
      `- PR: ${status.url}`,
      status.headSha ? `  Head: ${status.headSha}` : null,
      `  Retry attempt: ${plan.attempt} of ${plan.maxAttempts}`,
      `  Checks: ${plan.checkNames.join(", ")}`,
      `  Actions runs: ${plan.runIds.join(", ")}`,
      `  Reason: ${plan.reason}`,
      "",
      "  Diagnostics:",
      indentForComment(summarizeCheckDiagnostics(plan.diagnostics), 2)
    ]),
    "",
    "AgentOS did not retry deterministic mechanical failures, ambiguous/logless failures, external checks, protected branch requirements, or merge queue requirements from this path."
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function flakyCiRetryFailedComment(status: PullRequestStatus, plan: FlakyCiRetryPlan, error: string): string {
  return [
    "### AgentOS flaky CI retry needs human judgment",
    "",
    "AgentOS classified a failed check as flaky/retryable, but the GitHub Actions rerun request failed.",
    "",
    `- PR: ${status.url}`,
    status.headSha ? `- Head: ${status.headSha}` : null,
    `- Retry attempt: ${plan.attempt} of ${plan.maxAttempts}`,
    `- Checks: ${plan.checkNames.join(", ")}`,
    `- Actions runs: ${plan.runIds.join(", ")}`,
    `- Error: ${error}`
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function flakyCiRetryExhaustedComment(items: Array<{ status: PullRequestStatus; plan: FlakyCiRetryPlan }>): string {
  return [
    "### AgentOS flaky CI retry exhausted",
    "",
    "AgentOS classified the failed check(s) as supported flaky/retryable, but the configured retry budget is exhausted for the selected PR head.",
    "",
    ...items.flatMap(({ status, plan }) => [
      `- PR: ${status.url}`,
      status.headSha ? `  Head: ${status.headSha}` : null,
      `  Retry budget: ${plan.attempt} of ${plan.maxAttempts}`,
      `  Checks: ${plan.checkNames.join(", ")}`,
      `  Actions runs: ${plan.runIds.join(", ")}`,
      `  Reason: ${plan.reason}`
    ])
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function indentForComment(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
