import type { MonitorHumanActionReasonCode } from "./monitor-contracts.js";
import type { MonitorEmitter } from "./monitor-sink.js";
import type { Issue } from "./types.js";

type PreDispatchMonitorPauseReason = Extract<MonitorHumanActionReasonCode, "planning_required" | "recovery_needed" | "blocked">;

export async function emitPreDispatchMonitorPause(input: {
  monitorEmitter: MonitorEmitter;
  issue: Issue;
  label: string;
  message: string;
  reasonCode: PreDispatchMonitorPauseReason;
}): Promise<void> {
  const timestamp = new Date().toISOString();
  const runId = `pre_dispatch_${input.issue.identifier}_${Date.now()}`;
  const waitSpanId = `${runId}:needs-input`;
  await input.monitorEmitter.emit(runId, {
    type: "run_started",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: input.issue.title,
    timestamp
  });
  await input.monitorEmitter.emit(runId, {
    type: "phase_started",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: input.label,
    timestamp,
    payload: {
      timing: {
        id: waitSpanId,
        phase: "needs-input",
        status: "waiting",
        label: input.label,
        startedAt: timestamp,
        metadata: { reason: input.message }
      }
    }
  });
  await input.monitorEmitter.emit(runId, {
    type: "human_action_required",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: input.label,
    timestamp,
    payload: {
      monitor: {
        humanAction: {
          reasonCode: input.reasonCode,
          details: input.message
        },
        result: input.message
      }
    }
  });
}
