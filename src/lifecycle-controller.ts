import { lifecycleCommentKey, lifecycleCommentMarker } from "./lifecycle-comment-markers.js";
import { orchestratorMayComment, orchestratorMayMoveIssue, type LifecycleCommentKind } from "./lifecycle.js";
import { schedulerSafetyWriteReasons } from "./lifecycle-events.js";
import type { LifecycleController, LifecycleControllerRecordResult, LifecycleEvent, LifecycleTrackerUpdateResult } from "./lifecycle-events.js";
import type { JsonlLogger } from "./logging.js";
import { reviewStateBlocksTrackerUpdate } from "./orchestrator-tracker-guard.js";
import { redactText } from "./redaction.js";
import type { TrackerCapabilities } from "./tracker-boundaries.js";
import type { Issue, ServiceConfig } from "./types.js";

export type { LifecycleTrackerUpdateResult } from "./lifecycle-events.js";

export interface TrackerLifecycleControllerOptions {
  config: ServiceConfig;
  tracker: TrackerCapabilities;
  logger: JsonlLogger;
}

export class TrackerLifecycleController implements LifecycleController {
  constructor(private readonly options: TrackerLifecycleControllerOptions) {}

  async record(event: LifecycleEvent): Promise<LifecycleControllerRecordResult> {
    if (event.type === "state_transition_requested") {
      return { trackerUpdateResult: await this.moveIssue(event) };
    }
    if (event.commentBody != null) {
      return { trackerUpdateResult: await this.commentIssue(event) };
    }
    return {};
  }

  private async moveIssue(event: LifecycleEvent): Promise<LifecycleTrackerUpdateResult> {
    const stateName = event.requestedState ?? null;
    if (!stateName || !this.options.tracker.move || !mayWriteLifecycle(event, orchestratorMayMoveIssue(this.options.config))) {
      return this.withSchedulerSafetyLog(event, "move", "unsupported");
    }
    const issue = issueFromLifecycleEvent(event);
    if (
      await reviewStateBlocksTrackerUpdate({
        config: this.options.config,
        tracker: this.options.tracker,
        logger: this.options.logger,
        issue,
        operation: `move to ${stateName}`
      })
    ) {
      return this.withSchedulerSafetyLog(event, "move", "blocked");
    }
    try {
      await this.options.tracker.move(issue.identifier, stateName);
      return this.withSchedulerSafetyLog(event, "move", "applied");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `move to ${stateName}: ${message}`
      });
      return this.withSchedulerSafetyLog(event, "move", "failed");
    }
  }

  private async commentIssue(event: LifecycleEvent): Promise<LifecycleTrackerUpdateResult> {
    const kind: LifecycleCommentKind = event.commentKind ?? "bookkeeping";
    if (isSchedulerSafetyWrite(event) && kind === "substantive") return this.withSchedulerSafetyLog(event, "comment", "unsupported");
    if (!mayWriteLifecycle(event, orchestratorMayComment(this.options.config, kind))) return this.withSchedulerSafetyLog(event, "comment", "unsupported");
    if (!this.options.tracker.comment && !this.options.tracker.upsertComment) return this.withSchedulerSafetyLog(event, "comment", "unsupported");
    const issue = issueFromLifecycleEvent(event);
    if (
      await reviewStateBlocksTrackerUpdate({
        config: this.options.config,
        tracker: this.options.tracker,
        logger: this.options.logger,
        issue,
        operation: "comment"
      })
    ) {
      return this.withSchedulerSafetyLog(event, "comment", "blocked");
    }
    const safeBody = redactText(event.commentKey ? `${lifecycleCommentMarker(event.commentKey, issue.identifier)}\n${event.commentBody ?? ""}` : event.commentBody ?? "");
    const operation =
      event.commentKey && this.options.tracker.upsertComment
        ? this.options.tracker.upsertComment(issue.identifier, safeBody, lifecycleCommentKey(event.commentKey, issue.identifier))
        : this.options.tracker.comment!(issue.identifier, safeBody);
    try {
      await operation;
      return this.withSchedulerSafetyLog(event, "comment", "applied");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.logger.write({
        type: "linear_update_failed",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: `comment: ${message}`
      });
      return this.withSchedulerSafetyLog(event, "comment", "failed");
    }
  }

  private async withSchedulerSafetyLog(event: LifecycleEvent, operation: "move" | "comment", result: LifecycleTrackerUpdateResult): Promise<LifecycleTrackerUpdateResult> {
    if (!isSchedulerSafetyWrite(event)) return result;
    await this.options.logger.write({
      type: "scheduler_safety",
      issueId: event.issueId,
      issueIdentifier: event.issueIdentifier,
      message: `${event.safetyReason}:${operation}:${result}`,
      payload: { reason: event.safetyReason, operation, result, requestedState: event.requestedState, commentKey: event.commentKey }
    });
    return result;
  }
}

function mayWriteLifecycle(event: LifecycleEvent, defaultAllowed: boolean): boolean {
  return defaultAllowed || isSchedulerSafetyWrite(event);
}

function isSchedulerSafetyWrite(event: LifecycleEvent): boolean {
  return event.actor === "scheduler_safety" && schedulerSafetyWriteReasons.includes(event.safetyReason as (typeof schedulerSafetyWriteReasons)[number]);
}

function issueFromLifecycleEvent(event: LifecycleEvent): Issue {
  return {
    id: event.issueId,
    identifier: event.issueIdentifier,
    title: "",
    description: null,
    priority: null,
    state: event.issueState ?? "",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
