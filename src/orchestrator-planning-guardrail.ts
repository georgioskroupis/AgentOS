import type { TrackerLifecycleController } from "./lifecycle-controller.js";
import type { MonitorEmitter } from "./monitor-sink.js";
import { emitPreDispatchMonitorPause } from "./orchestrator-pre-dispatch-monitor.js";
import { planningRecommendedCommentBody } from "./orchestrator-planning-comments.js";
import { schedulerSafetyCommentIssue, schedulerSafetyMoveIssue } from "./orchestrator-scheduler-safety.js";
import type { PhaseTimingEventInput } from "./phase-timing.js";
import { scopeReportStateFromReport, type PreDispatchScopeReport } from "./scope-report.js";
import type { Issue, IssueState, ServiceConfig } from "./types.js";

export async function markLinearPlanningRecommended(input: {
  issue: Issue;
  report: PreDispatchScopeReport;
  config: ServiceConfig;
  lifecycleController: TrackerLifecycleController;
  monitorEmitter: MonitorEmitter;
  recordDispatchGuardrailStop(issue: Issue, message: string, patch: Partial<IssueState>): Promise<IssueState>;
  writePhaseTimingEvent(issue: Issue, event: PhaseTimingEventInput): Promise<void>;
}): Promise<void> {
  const message = input.report.dispatchAdvice.reason ?? "likely-large scope needs planning or decomposition before implementation dispatch";
  await input.recordDispatchGuardrailStop(input.issue, message, {
    phase: "needs-input",
    lifecycleStatus: "planning_required",
    lastError: message,
    errorCategory: "prompt",
    stopReason: message,
    scopeReport: scopeReportStateFromReport(input.report)
  });
  await schedulerSafetyCommentIssue({ controller: input.lifecycleController, issue: input.issue, body: planningRecommendedCommentBody(input.report), key: "planning_recommended", safetyReason: "pre_dispatch_safety_block" });
  await schedulerSafetyMoveIssue({ controller: input.lifecycleController, issue: input.issue, stateName: input.config.tracker.needsInputState, safetyReason: "pre_dispatch_safety_block" });
  await input.writePhaseTimingEvent(input.issue, {
    phase: "needs-input",
    status: "waiting",
    label: "planning/decomposition pause started",
    metadata: {
      needsInputState: input.config.tracker.needsInputState,
      reason: message,
      scopeSize: input.report.scopeSize,
      likelyLarge: input.report.likelyLarge
    }
  });
  await emitPreDispatchMonitorPause({
    monitorEmitter: input.monitorEmitter,
    issue: input.issue,
    label: "Planning/decomposition required",
    message,
    reasonCode: "planning_required"
  });
}
