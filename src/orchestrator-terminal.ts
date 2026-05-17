import { join } from "node:path";
import type { PullRequestStatus } from "./github.js";
import { exists } from "./fs-utils.js";
import type { RunTimingPhase } from "./runs.js";
import type { Issue, IssueState } from "./types.js";

const TERMINAL_WAIT_PHASES: RunTimingPhase[] = ["human-wait", "needs-input", "ci-wait"];

export interface TerminalWaitPhaseFinish {
  runId: string;
  phase: RunTimingPhase;
  metadata: Record<string, unknown>;
}

export function terminalWaitPhaseFinishes(issue: Issue, state: IssueState | null, reason: string): TerminalWaitPhaseFinish[] {
  const runId = state?.lastRunId;
  if (!runId) return [];
  return TERMINAL_WAIT_PHASES.map((phase) => ({
    runId,
    phase,
    metadata: { reason, terminalState: issue.state }
  }));
}

export function terminalWorkspaceWarning(issue: Issue, state: IssueState | null, missingWorkspace: boolean): boolean {
  return Boolean(missingWorkspace && !(state?.lifecycleStatus === "terminal_linear" && state.terminalState === issue.state && !state.workspaceMissingAt));
}

export async function isOperatorRecoveryTimingRunMissingSummary(repoRoot: string, state: IssueState | null, runId: string): Promise<boolean> {
  if (!state?.operatorRecovery) return false;
  const recoveredRunIds = new Set([state.operatorRecovery.runId, state.validation?.runId].filter((value): value is string => Boolean(value)));
  return recoveredRunIds.has(runId) && !(await exists(join(repoRoot, ".agent-os", "runs", runId, "summary.json")));
}

export function alreadyMergedIssuePatch(
  state: IssueState | null,
  pr: PullRequestStatus,
  terminalAt: string,
  reason: string,
  cleanupWarnings: string[] = []
): Partial<IssueState> {
  return {
    phase: "completed",
    lifecycleStatus: "already_merged_pr",
    mergedAt: terminalAt,
    terminalReason: reason,
    terminalAt,
    reviewStatus: undefined,
    lastError: undefined,
    errorCategory: undefined,
    activeRunId: undefined,
    nextRetryAt: undefined,
    retryAttempt: undefined,
    workspaceMissingAt: undefined,
    mergeCleanupWarnings: cleanupWarnings.length ? cleanupWarnings : undefined,
    ...terminalHeadPatch(state, pr, terminalAt),
    stopReason: reason
  };
}

export function terminalHeadPatch(state: IssueState | null, pr: PullRequestStatus | null, checkedAt: string): Partial<IssueState> {
  const headSha = pr?.headSha ?? state?.validation?.githubCi?.headSha ?? state?.headSha ?? null;
  if (!headSha) return {};
  return {
    headSha,
    lastReviewedSha: headSha,
    lastFixedSha: headSha,
    ...(state?.validation ? { validation: refreshValidationHead(state.validation, pr, headSha, checkedAt) } : {})
  };
}

function refreshValidationHead(validation: NonNullable<IssueState["validation"]>, pr: PullRequestStatus | null, headSha: string, checkedAt: string): NonNullable<IssueState["validation"]> {
  const existingCi = validation.githubCi;
  const prChecksPassed = pr ? pr.checkSummary.total > 0 && pr.checkSummary.failing === 0 && pr.checkSummary.pending === 0 && pr.checkSummary.successful > 0 : false;
  return {
    ...validation,
    githubCi:
      existingCi || pr
        ? {
            status: prChecksPassed ? "passed" : existingCi?.status ?? "pending",
            source: existingCi?.source ?? "github-pr",
            checkedAt,
            headSha
          }
        : validation.githubCi
  };
}
