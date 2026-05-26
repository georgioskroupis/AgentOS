import { latestAuthoritativeHumanDecision } from "./issue-state.js";
import type { HumanDecisionState, IssueState, LifecycleStatus } from "./types.js";

export function recoverablePartialWorkStatePatch(message: string): Partial<IssueState> {
  return {
    phase: "human-required",
    reviewStatus: "human_required",
    lifecycleStatus: "implementation_failure",
    lastError: message,
    errorCategory: "workspace",
    stopReason: message,
    activeRunId: undefined,
    nextRetryAt: undefined,
    retryAttempt: undefined
  };
}

export function isSupervisorContinuationPaused(state: IssueState | null): boolean {
  if (!state?.lifecycleStatus || !["human_continuation", "supervisor_continuation", "externally_fixed"].includes(state.lifecycleStatus)) return false;
  const decision = latestAuthoritativeDecision(state);
  return Boolean(decision && decision.type !== "fix_findings");
}

export function latestAuthoritativeDecision(state: IssueState | null | undefined): HumanDecisionState | null {
  return latestAuthoritativeHumanDecision([...(state?.humanDecisions ?? []), ...(state?.lastHumanDecision ? [state.lastHumanDecision] : [])]);
}

export function lifecycleStatusForHumanDecision(decision: HumanDecisionState): LifecycleStatus {
  if (decision.type === "fix_findings") return "human_continuation";
  return decision.type === "proceed_to_merge_after_supervisor_fix" ? "externally_fixed" : "supervisor_continuation";
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
}
