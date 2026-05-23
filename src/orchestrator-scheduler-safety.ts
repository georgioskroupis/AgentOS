import type { LifecycleController, LifecycleTrackerUpdateResult, SchedulerSafetyWriteReason } from "./lifecycle-events.js";
import type { Issue } from "./types.js";

export async function schedulerSafetyMoveIssue(input: {
  controller: LifecycleController;
  issue: Issue;
  stateName: string | null;
  safetyReason: SchedulerSafetyWriteReason;
}): Promise<LifecycleTrackerUpdateResult> {
  if (!input.stateName) return "unsupported";
  const result = await input.controller.record({
    schemaVersion: 1,
    actor: "scheduler_safety",
    type: "state_transition_requested",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    issueState: input.issue.state,
    source: "orchestrator",
    requestedState: input.stateName,
    safetyReason: input.safetyReason,
    createdAt: new Date().toISOString()
  });
  return result.trackerUpdateResult ?? "unsupported";
}

export async function schedulerSafetyCommentIssue(input: {
  controller: LifecycleController;
  issue: Issue;
  body: string;
  key: string;
  safetyReason: SchedulerSafetyWriteReason;
}): Promise<void> {
  await input.controller.record({
    schemaVersion: 1,
    actor: "scheduler_safety",
    type: "progress_comment",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    issueState: input.issue.state,
    source: "orchestrator",
    commentBody: input.body,
    commentKey: input.key,
    commentKind: "bookkeeping",
    safetyReason: input.safetyReason,
    createdAt: new Date().toISOString()
  });
}
