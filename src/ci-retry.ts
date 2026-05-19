import { createHash } from "node:crypto";
import { checkDetailLifecycleState, summarizeCheckDiagnostics, type CheckDiagnostic, type PullRequestStatus } from "./github.js";
import { trustCapabilities } from "./trust.js";
import type { CiRetryAttemptState, IssueState, ReviewFinding, ServiceConfig } from "./types.js";

export interface FlakyCiRetryPlan {
  action: "retry" | "exhausted" | "skip";
  diagnostics: CheckDiagnostic[];
  runIds: string[];
  checkNames: string[];
  attempt: number;
  maxAttempts: number;
  reason: string;
}

export function planFlakyCiRetry(input: {
  config: ServiceConfig;
  state: IssueState | null;
  status: PullRequestStatus;
  diagnostics: CheckDiagnostic[];
}): FlakyCiRetryPlan {
  const maxAttempts = input.config.agent.maxRetryAttempts;
  const failingDiagnostics = input.diagnostics.filter((diagnostic) => checkDetailLifecycleState(diagnostic.check) === "failing");
  const retryable = failingDiagnostics.filter((diagnostic) => diagnostic.classification === "flaky_retryable" && diagnostic.actionsRunId);
  const runIds = unique(retryable.map((diagnostic) => diagnostic.actionsRunId).filter((runId): runId is string => Boolean(runId)));
  const checkNames = unique(retryable.map((diagnostic) => diagnostic.check.name));
  const priorAttempts = priorFlakyCiRetryAttempts(input.state, input.status.url, input.status.headSha);
  const attempt = priorAttempts + 1;
  const capabilities = trustCapabilities(input.config.trustMode);
  if (input.status.checkSummary.failing === 0) {
    return { action: "skip", diagnostics: [], runIds: [], checkNames: [], attempt, maxAttempts, reason: "no failing checks" };
  }
  if (input.config.automation.repairPolicy !== "mechanical-first") {
    return { action: "skip", diagnostics: retryable, runIds, checkNames, attempt, maxAttempts, reason: "automation.repair_policy is not mechanical-first" };
  }
  if (!capabilities.prNetwork) {
    return { action: "skip", diagnostics: retryable, runIds, checkNames, attempt, maxAttempts, reason: `trust_mode=${input.config.trustMode} does not allow PR/network capability` };
  }
  if (retryable.length === 0) {
    return { action: "skip", diagnostics: [], runIds: [], checkNames: [], attempt, maxAttempts, reason: "no supported flaky/retryable diagnostics" };
  }
  if (retryable.length !== failingDiagnostics.length || retryable.length !== input.status.checkSummary.failing) {
    return {
      action: "skip",
      diagnostics: retryable,
      runIds,
      checkNames,
      attempt,
      maxAttempts,
      reason: "failed check set is not exclusively supported flaky/retryable diagnostics"
    };
  }
  if (runIds.length === 0) {
    return { action: "skip", diagnostics: retryable, runIds, checkNames, attempt, maxAttempts, reason: "retryable diagnostics did not include verified GitHub Actions run ids" };
  }
  if (priorAttempts >= maxAttempts) {
    return { action: "exhausted", diagnostics: retryable, runIds, checkNames, attempt: priorAttempts, maxAttempts, reason: `flaky CI retry budget exhausted (${priorAttempts}/${maxAttempts})` };
  }
  return {
    action: "retry",
    diagnostics: retryable,
    runIds,
    checkNames,
    attempt,
    maxAttempts,
    reason: `supported flaky CI retry ${attempt} of ${maxAttempts}`
  };
}

export function ciRetryAttemptFromPlan(input: {
  plan: FlakyCiRetryPlan;
  status: PullRequestStatus;
  attemptedAt: string;
  statusValue: CiRetryAttemptState["status"];
  error?: string;
}): CiRetryAttemptState {
  return {
    status: input.statusValue,
    attemptedAt: input.attemptedAt,
    attempt: input.plan.attempt,
    maxAttempts: input.plan.maxAttempts,
    prUrl: input.status.url,
    headSha: input.status.headSha,
    checkNames: input.plan.checkNames,
    runIds: input.plan.runIds,
    classification: "flaky_retryable",
    reason: input.plan.reason,
    ...(input.error ? { error: input.error } : {})
  };
}

export function flakyCiRetryExhaustedFinding(plan: FlakyCiRetryPlan, status: PullRequestStatus): ReviewFinding {
  const body = [
    `${plan.diagnostics.length} GitHub check(s) are classified as flaky/retryable, but the bounded retry budget is exhausted for this PR head.`,
    "",
    `Attempt budget: ${plan.attempt}/${plan.maxAttempts}`,
    `PR: ${status.url}`,
    status.headSha ? `Head: ${status.headSha}` : null,
    "",
    summarizeCheckDiagnostics(plan.diagnostics)
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return {
    reviewer: "checks",
    decision: "human_required",
    severity: "P1",
    file: null,
    line: null,
    body,
    findingHash: `checks-flaky-retry-exhausted-${fingerprint(plan, status)}`
  };
}

export function flakyCiRetryUnhandledFinding(plan: FlakyCiRetryPlan, status: PullRequestStatus): ReviewFinding | null {
  if (plan.diagnostics.length === 0) return null;
  const body = [
    `${plan.diagnostics.length} GitHub check(s) are classified as flaky/retryable, but AgentOS did not request a bounded retry.`,
    "",
    `Reason: ${plan.reason}`,
    `PR: ${status.url}`,
    status.headSha ? `Head: ${status.headSha}` : null,
    "",
    summarizeCheckDiagnostics(plan.diagnostics)
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return {
    reviewer: "checks",
    decision: "human_required",
    severity: "P1",
    file: null,
    line: null,
    body,
    findingHash: `checks-flaky-retry-unhandled-${fingerprint(plan, status)}`
  };
}

function priorFlakyCiRetryAttempts(state: IssueState | null, prUrl: string, headSha: string | null): number {
  return (state?.ciRetry?.attempts ?? []).filter((attempt) => attempt.prUrl === prUrl && sameSha(attempt.headSha, headSha) && attempt.status === "requested").length;
}

function fingerprint(plan: FlakyCiRetryPlan, status: PullRequestStatus): string {
  return createHash("sha256")
    .update([status.url, status.headSha ?? "", plan.reason, ...plan.checkNames, ...plan.runIds].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
