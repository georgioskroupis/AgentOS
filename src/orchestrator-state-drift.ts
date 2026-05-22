import type { JsonlLogger } from "./logging.js";
import type { Issue, IssueState, ServiceConfig } from "./types.js";

export interface ExternalHumanReviewStateDrift {
  expectedState: string;
  currentState: string;
  reason: string;
  nextAction: string;
}

export function detectExternalHumanReviewStateDrift(input: {
  config: ServiceConfig;
  issue: Issue;
  state: IssueState | null;
  allowsImplementationContinuation: boolean;
}): ExternalHumanReviewStateDrift | null {
  const { config, issue, state, allowsImplementationContinuation } = input;
  const expectedState = config.tracker.reviewState;
  if (!expectedState || !state || allowsImplementationContinuation) return null;
  if (isStateIn(issue.state, [expectedState])) return null;
  if (config.tracker.mergeState && isStateIn(issue.state, [config.tracker.mergeState])) return null;
  if (!config.tracker.runningState || !isStateIn(issue.state, [config.tracker.runningState])) return null;

  const reason = humanReviewHeldReason(config, issue, state);
  if (!reason) return null;
  return {
    expectedState,
    currentState: issue.state,
    reason,
    nextAction: `keep the issue in ${expectedState}; record a trusted structured human decision before returning it to an active implementation state`
  };
}

export async function recordExternalHumanReviewStateDrift(input: {
  issue: Issue;
  drift: ExternalHumanReviewStateDrift;
  recordIssueState(issue: Issue, patch: Partial<IssueState>): Promise<IssueState>;
  clearRuntimeIssue(issueId: string, issueIdentifier: string): Promise<void>;
  deleteRetry(issueId: string): void;
  logger: JsonlLogger;
  commentIssue(issue: Issue, body: string, key: string): Promise<void>;
  moveIssue(issue: Issue, stateName: string): Promise<"applied" | "unsupported" | "failed" | "blocked">;
}): Promise<void> {
  const { issue, drift } = input;
  const detectedAt = new Date().toISOString();
  const message = `external_state_drift: expected ${drift.expectedState} but Linear is ${drift.currentState}; ${drift.reason}`;
  await input.recordIssueState(issue, {
    phase: "human-required",
    stopReason: message,
    externalStateDrift: {
      status: "detected",
      expectedState: drift.expectedState,
      currentState: drift.currentState,
      detectedAt,
      reason: drift.reason,
      nextAction: drift.nextAction
    },
    activeRunId: undefined,
    nextRetryAt: undefined,
    retryAttempt: undefined
  });
  await input.clearRuntimeIssue(issue.id, issue.identifier);
  input.deleteRetry(issue.id);
  await input.logger.write({
    type: "external_state_drift",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    message,
    payload: drift
  });
  await input.commentIssue(issue, externalStateDriftComment(drift), "external_state_drift");
  const moveResult = await input.moveIssue(issue, drift.expectedState);
  await input.recordIssueState(issue, {
    externalStateDrift: {
      status: moveResult === "applied" ? "reconciled" : "blocked",
      expectedState: drift.expectedState,
      currentState: drift.currentState,
      detectedAt,
      reason: drift.reason,
      nextAction: drift.nextAction,
      ...(moveResult === "applied" ? { reconciledAt: new Date().toISOString(), reconciliation: "moved_to_expected_state" as const } : { reconciliation: "unsupported" as const })
    }
  });
}

function externalStateDriftComment(drift: ExternalHumanReviewStateDrift): string {
  return [
    "### AgentOS external state drift detected",
    "",
    `AgentOS expected this issue to remain in \`${drift.expectedState}\`, but the tracker currently reports \`${drift.currentState}\`.`,
    "",
    `Reason: ${drift.reason}.`,
    "",
    `Next safe action: ${drift.nextAction}.`,
    "",
    "AgentOS will not dispatch implementation work from this state drift. Disable or adjust conflicting Linear/GitHub status automations when AgentOS owns lifecycle state."
  ].join("\n");
}

function humanReviewHeldReason(config: ServiceConfig, issue: Issue, state: IssueState): string | null {
  if (state.lifecycleStatus === "supervisor_continuation" || state.lifecycleStatus === "externally_fixed") return null;
  if (state.reviewStatus === "human_required" || state.phase === "human-required") return "local AgentOS state still requires Human Review";
  if (state.phase === "completed" && state.reviewStatus !== "approved") return "local AgentOS handoff is completed and awaiting Human Review";
  return null;
}

function isStateIn(state: string, states: string[]): boolean {
  const normalized = state.toLowerCase();
  return states.map((item) => item.toLowerCase()).includes(normalized);
}
