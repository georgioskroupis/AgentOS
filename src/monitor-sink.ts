import type { JsonlLogger } from "./logging.js";
import type { MonitorEvent, MonitorSink } from "./monitor-contracts.js";
import type { AgentEvent } from "./types.js";

type MonitorEventKind = MonitorEvent["kind"];
type MonitorEventStatus = NonNullable<MonitorEvent["status"]>;
type MonitorTimeClass = NonNullable<MonitorEvent["timeClass"]>;

export interface MonitorEmitter {
  emit(runId: string, event: AgentEvent & { runId?: string }): Promise<void>;
}

export function createMonitorEmitter(input: { sink: MonitorSink; logger: JsonlLogger }): MonitorEmitter {
  let sequence = 0;
  return {
    async emit(runId, event) {
      const kind = monitorKind(event.type);
      if (!kind) return;
      const timestamp = event.timestamp ?? new Date().toISOString();
      const spanId = monitorSpanId(runId, event);
      const parentSpanId = monitorParentSpanId(runId, spanId);
      const monitorEvent: MonitorEvent = {
        eventId: `${runId}:${sequence++}:${event.type}`,
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        runId,
        issueId: event.issueIdentifier ?? event.issueId,
        timestamp,
        kind,
        label: event.message ?? event.type,
        status: monitorStatus(event.type),
        timeClass: monitorTimeClass(event)
      };
      try {
        await input.sink.emit(monitorEvent);
      } catch (error) {
        await input.logger
          .write({
            type: "monitor_sink_warning",
            issueId: event.issueId,
            issueIdentifier: event.issueIdentifier,
            message: error instanceof Error ? error.message : String(error)
          })
          .catch(() => undefined);
      }
    }
  };
}

function monitorKind(type: string): MonitorEventKind | null {
  if (type === "run_started") return "run_started";
  if (type === "run_succeeded") return "run_finished";
  if (type === "run_failed" || type === "run_canceled" || type === "run_stalled" || type === "run_timed_out") return "run_failed";
  if (type === "phase_started") return "stage_started";
  if (type === "phase_finished") return "stage_finished";
  if (type === "turn_completed") return "step_finished";
  if (type === "validation_failed") return "validation_finished";
  if (type === "review_started" || type === "review_fix_started" || type === "merge_shepherd_started") return "stage_started";
  return null;
}

function monitorStatus(type: string): MonitorEventStatus | undefined {
  if (type.endsWith("_started")) return "active";
  if (type.includes("failed") || type === "run_stalled" || type === "run_timed_out") return "failed";
  if (type.endsWith("_finished") || type === "run_succeeded" || type === "turn_completed") return "done";
  return undefined;
}

function monitorTimeClass(event: AgentEvent): MonitorTimeClass | undefined {
  const phase = timingPhase(event);
  if (phase === "implementation" || phase === "automated-review" || phase === "fixer-turn") return "agent";
  if (phase === "validation") return "validation";
  if (phase === "human-wait" || phase === "needs-input") return "human-wait";
  if (phase === "ci-wait" || phase === "retry-backoff") return "external-wait";
  if (phase === "merge-shepherding" || phase === "stall-cancel") return "scheduler";
  if (event.type.startsWith("review_")) return "agent";
  if (event.type === "merge_shepherd_started") return "scheduler";
  return undefined;
}

function monitorSpanId(runId: string, event: AgentEvent): string {
  if (isRunEvent(event.type)) {
    return `${runId}:run`;
  }
  const timing = timingPayload(event);
  return typeof timing?.id === "string" ? timing.id : `${runId}:${event.type}`;
}

function monitorParentSpanId(runId: string, spanId: string): string | undefined {
  if (spanId === `${runId}:run`) return undefined;
  return `${runId}:run`;
}

function isRunEvent(type: string): boolean {
  return type === "run_started" || type === "run_succeeded" || type === "run_failed" || type === "run_canceled" || type === "run_stalled" || type === "run_timed_out";
}

function timingPhase(event: AgentEvent): string | undefined {
  const phase = timingPayload(event)?.phase;
  return typeof phase === "string" ? phase : undefined;
}

function timingPayload(event: AgentEvent): Record<string, unknown> | undefined {
  if (typeof event.payload !== "object" || event.payload == null) return undefined;
  const timing = (event.payload as { timing?: unknown }).timing;
  return typeof timing === "object" && timing != null ? (timing as Record<string, unknown>) : undefined;
}
