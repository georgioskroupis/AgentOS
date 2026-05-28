import { readHandoff, isStateIn } from "./orchestrator-state-helpers.js";
import type { AgentRunResult, Issue, ServiceConfig, Workspace } from "./types.js";
import type { RunTimingStatus } from "./runs.js";

export const HANDOFF_RUNNER_STREAM_STOP_REASON = "handoff_completed_runner_stream_stopped";
export const NON_DISPATCHABLE_RUNNER_STREAM_STOP_REASON = "issue_left_dispatchable_states";
export const TERMINAL_RUNNER_STREAM_STOP_REASON = "issue_entered_terminal_state";

export interface RunnerStreamStopTimingPresentation {
  reason: string;
  label: string;
  status: RunTimingStatus;
}

export function nonDispatchableRunnerStreamStopPresentation(stateName: string, config: ServiceConfig): RunnerStreamStopTimingPresentation {
  const handoffStateReached = isHandoffStateReached(stateName, config);
  return {
    reason: handoffStateReached ? HANDOFF_RUNNER_STREAM_STOP_REASON : NON_DISPATCHABLE_RUNNER_STREAM_STOP_REASON,
    label: handoffStateReached ? "handoff state reached; runner stream stopped" : "runner stream stopped after issue left active state",
    status: handoffStateReached ? "completed" : "canceled"
  };
}

export async function handoffRunnerStreamStopPresentation(input: {
  result: AgentRunResult;
  signal?: AbortSignal;
  workspace: Workspace;
  issue: Issue;
}): Promise<{ displayResult: AgentRunResult } | null> {
  if (input.result.status !== "canceled") return null;
  if (!isAbortReason(input.signal, HANDOFF_RUNNER_STREAM_STOP_REASON)) return null;
  if (!(await readHandoff(input.workspace.path, input.issue.identifier))) return null;
  return {
    displayResult: {
      ...input.result,
      status: "succeeded",
      error: "handoff completed; runner stream stopped"
    }
  };
}

function isHandoffStateReached(stateName: string, config: ServiceConfig): boolean {
  return isStateIn(stateName, [config.tracker.reviewState, config.tracker.needsInputState].filter((state): state is string => Boolean(state)));
}

function isAbortReason(signal: AbortSignal | undefined, expected: string): boolean {
  if (!signal?.aborted) return false;
  return (signal as AbortSignal & { reason?: unknown }).reason === expected;
}
