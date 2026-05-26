import type { LifecycleController, LifecycleTrackerUpdateResult } from "./lifecycle-events.js";
import { schedulerSafetyMoveIssue } from "./orchestrator-scheduler-safety.js";
import type { Issue, ServiceConfig } from "./types.js";

export async function moveIssueToRunningState(input: {
  config: ServiceConfig;
  lifecycleController: LifecycleController;
  issue: Issue;
  moveIssue: (issue: Issue, stateName: string | null) => Promise<LifecycleTrackerUpdateResult>;
}): Promise<LifecycleTrackerUpdateResult> {
  const moveResult = await input.moveIssue(input.issue, input.config.tracker.runningState);
  if (moveResult !== "unsupported" || !shouldSchedulerSyncRunStartedState(input.config, input.issue)) return moveResult;
  return schedulerSafetyMoveIssue({
    controller: input.lifecycleController,
    issue: input.issue,
    stateName: input.config.tracker.runningState,
    safetyReason: "run_started_state_sync"
  });
}

export function shouldSchedulerSyncRunStartedState(config: ServiceConfig, issue: Issue): boolean {
  if (config.lifecycle.mode !== "agent-owned") return false;
  const runningState = config.tracker.runningState;
  if (!runningState || sameWorkflowState(issue.state, runningState)) return false;
  return lifecycleTransitionConfigured(config, issue.state, runningState);
}

function lifecycleTransitionConfigured(config: ServiceConfig, fromState: string, toState: string): boolean {
  return config.lifecycle.allowedStateTransitions.some((transition) => {
    const parsed = transition.match(/^\s*(.+?)\s*->\s*(.+?)\s*$/);
    return Boolean(parsed && sameWorkflowState(parsed[1], fromState) && sameWorkflowState(parsed[2], toState));
  });
}

function sameWorkflowState(left: string | null | undefined, right: string | null | undefined): boolean {
  return normalizeWorkflowState(left) === normalizeWorkflowState(right);
}

function normalizeWorkflowState(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
