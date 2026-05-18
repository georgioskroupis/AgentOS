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
  if (!(await missingRunSummary(repoRoot, runId))) return false;
  if (!state?.operatorRecovery) return false;
  const recoveredRunId = state.operatorRecovery.runId ?? state.validation?.runId;
  return recoveredRunId === runId;
}

export async function isSyntheticTimingRunMissingSummary(repoRoot: string, state: IssueState | null, runId: string): Promise<boolean> {
  if (await isOperatorRecoveryTimingRunMissingSummary(repoRoot, state, runId)) return true;
  if (!(await missingRunSummary(repoRoot, runId))) return false;
  return isExternalSupervisorTimingRunId(state, runId);
}

function isExternalSupervisorTimingRunId(state: IssueState | null, runId: string): boolean {
  if (!state?.lifecycleStatus || !["externally_fixed", "merge_success", "post_merge_cleanup_warning", "already_merged_pr"].includes(state.lifecycleStatus)) return false;
  const supervisorFixed = [...(state.humanDecisions ?? []), ...(state.lastHumanDecision ? [state.lastHumanDecision] : [])].some(
    (decision) => decision.type === "proceed_to_merge_after_supervisor_fix" && decision.trusted !== false
  );
  if (!supervisorFixed) return false;
  return state.validation?.runId === runId || state.lastRunId === runId;
}

async function missingRunSummary(repoRoot: string, runId: string): Promise<boolean> {
  return !(await exists(join(repoRoot, ".agent-os", "runs", runId, "summary.json")));
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

export function dependencyDispatchStopPatch(runId: string): Partial<IssueState> {
  return {
    phase: "canceled",
    lastRunId: runId,
    lastError: undefined,
    errorCategory: undefined,
    lifecycleStatus: undefined,
    activeRunId: undefined,
    nextRetryAt: undefined,
    retryAttempt: undefined
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
