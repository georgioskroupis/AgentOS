import type { JsonlLogger } from "./logging.js";
import type { Issue, IssueTracker, ServiceConfig } from "./types.js";

export type TrackerUpdateResult = "applied" | "unsupported" | "failed" | "blocked";

export async function trackerDispatchStop(config: ServiceConfig, tracker: IssueTracker, issue: Issue): Promise<string | null> {
  const states = await tracker.fetchIssueStates([issue.id]).catch(() => null);
  const current = states?.get(issue.id);
  if (current === null) return "issue_no_longer_exists";
  const latest = current ?? issue;
  if (isStateIn(latest.state, config.tracker.terminalStates)) return `issue_became_terminal:${latest.state}`;
  if (!isStateIn(latest.state, runningAllowedStates(config))) return `issue_no_longer_dispatchable:${latest.state}`;
  const dependencyStop = dependencyDispatchStop(config, latest);
  if (dependencyStop) return dependencyStop;
  return null;
}

export function dependencyDispatchStop(config: ServiceConfig, issue: Issue): string | null {
  const blocker = issue.blocked_by.find((candidate) => !isStateIn(candidate.state ?? "", config.tracker.terminalStates));
  if (!blocker) return null;
  const blockerRef = blocker.identifier ?? blocker.id ?? "unknown";
  const blockerState = blocker.state ?? "unknown";
  return `issue_blocked_by_dependency:${blockerRef} (${blockerState})`;
}

export function isConfiguredReviewDispatchStop(config: ServiceConfig, reason: string): boolean {
  const reviewState = config.tracker.reviewState;
  return Boolean(reviewState && reason.toLowerCase() === `issue_no_longer_dispatchable:${reviewState}`.toLowerCase());
}

export async function reviewStateBlocksTrackerUpdate(input: {
  config: ServiceConfig;
  tracker: IssueTracker;
  logger: JsonlLogger;
  issue: Issue;
  operation: string;
}): Promise<boolean> {
  const { config, tracker, logger, issue, operation } = input;
  const reviewState = config.tracker.reviewState;
  if (!reviewState) return false;
  let current: Issue | null | undefined;
  try {
    current = (await tracker.fetchIssueStates([issue.id])).get(issue.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.write({
      type: "linear_update_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: `${operation}: could not verify current issue state before tracker update: ${message}`
    });
    return true;
  }
  if (current === null) {
    await logger.write({
      type: "linear_update_skipped",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: `${operation}: issue no longer exists in tracker`
    });
    return true;
  }
  const latest = current ?? issue;
  if (!isStateIn(latest.state, [reviewState])) return false;
  await logger.write({
    type: "linear_update_skipped",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    message: `${operation}: refused because issue is in ${reviewState}`
  });
  return true;
}

function runningAllowedStates(config: ServiceConfig): string[] {
  return [...config.tracker.activeStates, config.tracker.runningState].filter((state): state is string => Boolean(state));
}

function isStateIn(state: string, states: string[]): boolean {
  const normalized = state.toLowerCase();
  return states.map((item) => item.toLowerCase()).includes(normalized);
}
