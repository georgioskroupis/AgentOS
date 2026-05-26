import type { JsonlLogger } from "./logging.js";
import type { MonitorEvent, MonitorSink } from "./monitor-contracts.js";
import type { AgentEvent, ModelRoutingRole } from "./types.js";

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
      const timestamp = event.timestamp ?? new Date().toISOString();
      for (const derived of monitorEvents(runId, event, timestamp)) {
        const spanId = derived.spanId ?? monitorSpanId(runId, event, derived.kind);
        const parentSpanId = derived.parentSpanId ?? monitorParentSpanId(runId, spanId);
        const monitorEvent: MonitorEvent = {
          eventId: `${runId}:${sequence++}:${event.type}:${derived.kind}`,
          spanId,
          ...(parentSpanId ? { parentSpanId } : {}),
          runId,
          issueId: event.issueIdentifier ?? event.issueId,
          timestamp,
          kind: derived.kind,
          label: derived.label ?? monitorLabel(event, derived.kind),
          status: derived.status ?? monitorStatus(event, derived.kind),
          timeClass: derived.timeClass ?? monitorTimeClass(event, derived.kind),
          ...(derived.model ? { model: derived.model } : {}),
          ...(derived.iteration ? { iteration: derived.iteration } : {}),
          ...(derived.validation ? { validation: derived.validation } : {}),
          ...(derived.humanAction ? { humanAction: derived.humanAction } : {}),
          ...(derived.result ? { result: derived.result } : {})
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
    }
  };
}

type MonitorDerivedEvent = Partial<Pick<MonitorEvent, "spanId" | "parentSpanId" | "label" | "status" | "timeClass" | "model" | "iteration" | "validation" | "humanAction" | "result">> & {
  kind: MonitorEventKind;
};

function monitorEvents(runId: string, event: AgentEvent, timestamp: string): MonitorDerivedEvent[] {
  const explicit = monitorHints(event);
  if (explicit.kind) return [{ ...explicit, kind: explicit.kind }];

  const timing = timingPayload(event);
  if (event.type === "phase_started") return phaseStartedEvents(runId, event, timing);
  if (event.type === "phase_finished") return phaseFinishedEvents(runId, event, timing);

  const kind = monitorKind(event.type);
  if (!kind) return [];
  return [
    {
      kind,
      ...explicit,
      ...(kind === "model_started" || kind === "model_finished" ? { model: explicit.model ?? modelFromPayload(event), spanId: explicit.spanId ?? modelSpanId(runId, event) } : {}),
      ...(kind === "validation_started" || kind === "validation_finished" ? { validation: explicit.validation ?? validationFromPayload(event, timestamp) } : {}),
      ...(iterationFromPayload(event) ? { iteration: iterationFromPayload(event) } : {})
    }
  ];
}

function phaseStartedEvents(runId: string, event: AgentEvent, timing: Record<string, unknown> | undefined): MonitorDerivedEvent[] {
  const phase = timingPhase(event);
  const stage = stageEvent("stage_started", event, timing);
  if (phase === "validation") return [validationStageEvent(runId, "validation_started", event, timing)];
  if (isWaitPhase(phase)) return [waitEvent(runId, "wait_started", event, timing)];
  const loop = loopEventForPhase(runId, event, timing, "loop_started");
  const iteration = loopIterationEventForPhase(runId, event, timing, "loop_iteration_started");
  return [stage, ...(loop ? [loop] : []), ...(iteration ? [iteration] : [])];
}

function phaseFinishedEvents(runId: string, event: AgentEvent, timing: Record<string, unknown> | undefined): MonitorDerivedEvent[] {
  const phase = timingPhase(event);
  const stage = stageEvent("stage_finished", event, timing);
  if (phase === "validation") return [validationStageEvent(runId, "validation_finished", event, timing)];
  if (isWaitPhase(phase)) return [waitEvent(runId, "wait_finished", event, timing)];
  const iteration = loopIterationEventForPhase(runId, event, timing, "loop_iteration_finished");
  const loop = loopEventForPhase(runId, event, timing, "loop_finished");
  return [stage, ...(iteration ? [iteration] : []), ...(loop ? [loop] : [])];
}

function monitorKind(type: string): MonitorEventKind | null {
  if (type === "run_started") return "run_started";
  if (type === "run_succeeded") return "run_finished";
  if (type === "run_failed" || type === "run_canceled" || type === "run_stalled" || type === "run_timed_out") return "run_failed";
  if (type === "turn_started") return "step_started";
  if (type === "turn_completed") return "step_finished";
  if (type === "validation_command_started") return "validation_started";
  if (type === "validation_command_finished" || type === "validation_failed") return "validation_finished";
  if (type === "loop_started" || type === "loop_finished" || type === "loop_iteration_started" || type === "loop_iteration_finished") return type;
  if (type === "model_route_selected" || type.endsWith("_model_route_selected")) return "model_started";
  if (type === "model_finished" || type.endsWith("_model_finished")) return "model_finished";
  if (type === "human_action_required" || type === "review_human_required") return "human_action_required";
  if (type === "review_started" || type === "review_fix_started" || type === "merge_shepherd_started") return "stage_started";
  return null;
}

function monitorStatus(event: AgentEvent, kind: MonitorEventKind): MonitorEventStatus | undefined {
  const timing = timingPayload(event);
  const timingStatus = typeof timing?.status === "string" ? timing.status : undefined;
  if (kind === "wait_started") return "waiting";
  if (kind === "validation_finished") return validationStatusFromPayload(event, timingStatus);
  if (kind.endsWith("_started")) return "active";
  if (kind === "run_failed" || timingStatus === "failed" || timingStatus === "stalled" || event.type.includes("failed") || event.type === "run_stalled" || event.type === "run_timed_out") return "failed";
  if (kind.endsWith("_finished") || kind === "run_finished" || event.type === "turn_completed") return "done";
  return undefined;
}

function monitorTimeClass(event: AgentEvent, kind: MonitorEventKind): MonitorTimeClass | undefined {
  const phase = timingPhase(event);
  if (kind === "model_started" || kind === "model_finished") return "agent";
  if (kind === "validation_started" || kind === "validation_finished") return "validation";
  if (kind === "wait_started" || kind === "wait_finished") return phase === "human-wait" || phase === "needs-input" ? "human-wait" : "external-wait";
  if (phase === "implementation" || phase === "automated-review" || phase === "fixer-turn") return "agent";
  if (phase === "human-wait" || phase === "needs-input") return "human-wait";
  if (phase === "ci-wait" || phase === "retry-backoff") return "external-wait";
  if (phase === "merge-shepherding" || phase === "stall-cancel") return "scheduler";
  if (event.type.startsWith("review_")) return "agent";
  if (event.type === "merge_shepherd_started") return "scheduler";
  return undefined;
}

function monitorSpanId(runId: string, event: AgentEvent, kind: MonitorEventKind): string {
  if (isRunEvent(event.type)) {
    return `${runId}:run`;
  }
  if (kind === "model_started" || kind === "model_finished") return modelSpanId(runId, event);
  if (kind === "validation_started" || kind === "validation_finished") return validationSpanId(runId, event);
  if (kind === "wait_started" || kind === "wait_finished") return waitSpanId(runId, event);
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

function monitorHints(event: AgentEvent): Partial<MonitorDerivedEvent> {
  if (typeof event.payload !== "object" || event.payload == null) return {};
  const monitor = (event.payload as { monitor?: unknown }).monitor;
  if (typeof monitor !== "object" || monitor == null || Array.isArray(monitor)) return {};
  const hints = monitor as Partial<MonitorDerivedEvent>;
  return {
    ...(isMonitorKind(hints.kind) ? { kind: hints.kind } : {}),
    ...(typeof hints.spanId === "string" ? { spanId: hints.spanId } : {}),
    ...(typeof hints.parentSpanId === "string" ? { parentSpanId: hints.parentSpanId } : {}),
    ...(typeof hints.label === "string" ? { label: hints.label } : {}),
    ...(isMonitorStatus(hints.status) ? { status: hints.status } : {}),
    ...(isMonitorTimeClass(hints.timeClass) ? { timeClass: hints.timeClass } : {}),
    ...(hints.model && typeof hints.model.name === "string" ? { model: hints.model } : {}),
    ...(hints.iteration && typeof hints.iteration.current === "number" ? { iteration: hints.iteration } : {}),
    ...(hints.validation && typeof hints.validation.command === "string" ? { validation: hints.validation } : {}),
    ...(monitorHumanAction(hints.humanAction) ? { humanAction: monitorHumanAction(hints.humanAction) } : {}),
    ...(typeof hints.result === "string" ? { result: hints.result } : {})
  };
}

function stageEvent(kind: "stage_started" | "stage_finished", event: AgentEvent, timing: Record<string, unknown> | undefined): MonitorDerivedEvent {
  return {
    kind,
    label: timingLabel(event),
    status: kind === "stage_started" ? "active" : monitorStatus(event, kind),
    timeClass: monitorTimeClass(event, kind),
    ...(iterationFromTiming(timing) ? { iteration: iterationFromTiming(timing) } : {}),
    ...(timingResult(timing) ? { result: timingResult(timing) } : {})
  };
}

function waitEvent(runId: string, kind: "wait_started" | "wait_finished", event: AgentEvent, timing: Record<string, unknown> | undefined): MonitorDerivedEvent {
  return {
    kind,
    spanId: waitSpanIdFromTiming(runId, event, timing),
    label: timingLabel(event),
    status: kind === "wait_started" ? "waiting" : monitorStatus(event, kind),
    timeClass: monitorTimeClass(event, kind),
    ...(timingResult(timing) ? { result: timingResult(timing) } : {})
  };
}

function validationStageEvent(runId: string, kind: "validation_started" | "validation_finished", event: AgentEvent, timing: Record<string, unknown> | undefined): MonitorDerivedEvent {
  return {
    kind,
    spanId: validationSpanIdFromTiming(runId, event, timing),
    label: timingLabel(event),
    status: kind === "validation_started" ? "active" : monitorStatus(event, kind),
    timeClass: "validation",
    ...(timingResult(timing) ? { result: timingResult(timing) } : {})
  };
}

function loopEventForPhase(runId: string, event: AgentEvent, timing: Record<string, unknown> | undefined, kind: "loop_started" | "loop_finished"): MonitorDerivedEvent | null {
  const phase = timingPhase(event);
  const metadata = timingMetadata(timing);
  if (phase !== "implementation" && phase !== "automated-review" && phase !== "fixer-turn") return null;
  const spanId = `${runId}:${phase}:loop`;
  return {
    kind,
    spanId,
    label: phase === "automated-review" ? "Automated review loop" : phase === "fixer-turn" ? "Fixer loop" : "Implementation turn loop",
    status: kind === "loop_started" ? "active" : monitorStatus(event, kind),
    timeClass: "agent",
    ...(typeof metadata?.resultStatus === "string" ? { result: metadata.resultStatus } : {})
  };
}

function loopIterationEventForPhase(runId: string, event: AgentEvent, timing: Record<string, unknown> | undefined, kind: "loop_iteration_started" | "loop_iteration_finished"): MonitorDerivedEvent | null {
  const phase = timingPhase(event);
  const iteration = iterationFromTiming(timing);
  if (!iteration || (phase !== "implementation" && phase !== "automated-review" && phase !== "fixer-turn")) return null;
  const current = iteration.current;
  return {
    kind,
    spanId: `${runId}:${phase}:loop:${current}`,
    parentSpanId: `${runId}:${phase}:loop`,
    label: `${iteration.label} ${current}`,
    status: kind === "loop_iteration_started" ? "active" : monitorStatus(event, kind),
    timeClass: "agent",
    iteration,
    ...(timingResult(timing) ? { result: timingResult(timing) } : {})
  };
}

function monitorLabel(event: AgentEvent, kind: MonitorEventKind): string {
  if (event.type === "run_started" && event.message) return event.message;
  if (kind === "run_finished") return "Run finished";
  if (kind === "run_failed") return "Run failed";
  if (kind === "model_started") return modelLabel(event, "started");
  if (kind === "model_finished") return modelLabel(event, "finished");
  if (kind === "validation_started" || kind === "validation_finished") return validationLabel(event);
  if (event.message?.trim()) return event.message.trim();
  return humanize(event.type);
}

function timingLabel(event: AgentEvent): string {
  const timing = timingPayload(event);
  const label = typeof timing?.label === "string" && timing.label.trim() ? timing.label.trim() : null;
  const phase = timingPhase(event);
  return label ?? phaseLabel(phase) ?? monitorLabel(event, "stage_started");
}

function phaseLabel(phase: string | undefined): string | null {
  if (!phase) return null;
  const labels: Record<string, string> = {
    implementation: "Implementation",
    validation: "Validation",
    "automated-review": "Automated review",
    "fixer-turn": "Fixer turn",
    "ci-wait": "CI wait",
    "merge-shepherding": "Merge shepherding",
    "retry-backoff": "Retry backoff",
    "stall-cancel": "Stall cancellation",
    "human-wait": "Human review wait",
    "needs-input": "Needs input"
  };
  return labels[phase] ?? humanize(phase);
}

function modelLabel(event: AgentEvent, status: "started" | "finished"): string {
  const model = modelFromPayload(event);
  const role = model?.role === "other" ? "model" : `${model?.role ?? "model"} model`;
  return `${role} ${status}`;
}

function validationLabel(event: AgentEvent): string {
  const validation = validationFromPayload(event, event.timestamp);
  return validation ? `Validation command: ${validation.command}` : "Validation";
}

function modelFromPayload(event: AgentEvent): MonitorEvent["model"] | undefined {
  if (typeof event.payload !== "object" || event.payload == null) return undefined;
  const payload = event.payload as Record<string, unknown>;
  const rawModel = typeof payload.model === "string" ? payload.model : typeof payload.proposedModel === "string" ? payload.proposedModel : "inherited";
  const role = typeof payload.role === "string" ? monitorModelRole(payload.role) : "other";
  return { name: rawModel, role };
}

function validationFromPayload(event: AgentEvent, timestamp: string): MonitorEvent["validation"] | undefined {
  if (typeof event.payload !== "object" || event.payload == null) return undefined;
  const payload = event.payload as Record<string, unknown>;
  const command = typeof payload.command === "string" ? payload.command : typeof payload.name === "string" ? payload.name : undefined;
  if (!command) return undefined;
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : undefined;
  const startedAt = typeof payload.startedAt === "string" ? payload.startedAt : undefined;
  const finishedAt = typeof payload.finishedAt === "string" ? payload.finishedAt : timestamp;
  const durationMs = startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : undefined;
  return {
    command,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    status: validationResultStatus(payload.status, exitCode),
    ...(exitCode != null ? { exitCode } : {})
  };
}

function validationStatusFromPayload(event: AgentEvent, timingStatus: string | undefined): MonitorEventStatus | undefined {
  const validation = validationFromPayload(event, event.timestamp);
  if (validation?.status === "pass") return "pass";
  if (validation?.status === "skipped") return "skipped";
  if (validation?.status === "fail") return "failed";
  if (timingStatus === "completed") return "pass";
  if (timingStatus === "failed") return "failed";
  return undefined;
}

function validationResultStatus(status: unknown, exitCode: number | undefined): NonNullable<MonitorEvent["validation"]>["status"] {
  if (status === "skipped") return "skipped";
  if (status === "passed" || status === "pass") return "pass";
  if (status === "failed" || status === "fail") return "fail";
  return exitCode === 0 ? "pass" : exitCode == null ? "skipped" : "fail";
}

function iterationFromPayload(event: AgentEvent): MonitorEvent["iteration"] | undefined {
  if (typeof event.payload !== "object" || event.payload == null) return undefined;
  const payload = event.payload as Record<string, unknown>;
  return iterationFromRecord(payload);
}

function iterationFromTiming(timing: Record<string, unknown> | undefined): MonitorEvent["iteration"] | undefined {
  return iterationFromRecord(timingMetadata(timing) ?? {});
}

function iterationFromRecord(record: Record<string, unknown>): MonitorEvent["iteration"] | undefined {
  const current = numberValue(record.turnNumber ?? record.iteration ?? record.current);
  if (current == null) return undefined;
  return {
    current,
    ...(numberValue(record.maxTurns ?? record.maxIterations ?? record.max) != null ? { max: numberValue(record.maxTurns ?? record.maxIterations ?? record.max)! } : {}),
    label: typeof record.iterationLabel === "string" ? record.iterationLabel : typeof record.reviewer === "string" ? record.reviewer : "iteration"
  };
}

function timingMetadata(timing: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return typeof timing?.metadata === "object" && timing.metadata != null && !Array.isArray(timing.metadata) ? (timing.metadata as Record<string, unknown>) : undefined;
}

function timingResult(timing: Record<string, unknown> | undefined): string | undefined {
  const metadata = timingMetadata(timing);
  const value = metadata?.resultStatus ?? metadata?.reviewStatus ?? metadata?.reason ?? timing?.status;
  return typeof value === "string" ? value : undefined;
}

function modelSpanId(runId: string, event: AgentEvent): string {
  const payload = typeof event.payload === "object" && event.payload != null ? (event.payload as Record<string, unknown>) : {};
  const role = typeof payload.role === "string" ? payload.role : "other";
  const attempt = payload.attempt == null ? "none" : String(payload.attempt);
  return `${runId}:model:${role}:${attempt}`;
}

function validationSpanId(runId: string, event: AgentEvent): string {
  const payload = typeof event.payload === "object" && event.payload != null ? (event.payload as Record<string, unknown>) : {};
  const index = payload.index == null ? slug(typeof payload.command === "string" ? payload.command : event.type) : String(payload.index);
  return `${runId}:validation:${index}`;
}

function validationSpanIdFromTiming(runId: string, event: AgentEvent, timing: Record<string, unknown> | undefined): string {
  return typeof timing?.id === "string" ? timing.id : validationSpanId(runId, event);
}

function waitSpanId(runId: string, event: AgentEvent): string {
  const timing = timingPayload(event);
  return waitSpanIdFromTiming(runId, event, timing);
}

function waitSpanIdFromTiming(runId: string, event: AgentEvent, timing: Record<string, unknown> | undefined): string {
  return typeof timing?.id === "string" ? timing.id : `${runId}:wait:${timingPhase(event) ?? event.type}`;
}

function isWaitPhase(phase: string | undefined): boolean {
  return phase === "ci-wait" || phase === "retry-backoff" || phase === "human-wait" || phase === "needs-input";
}

function monitorModelRole(role: string): NonNullable<MonitorEvent["model"]>["role"] {
  const roles: Partial<Record<ModelRoutingRole, NonNullable<MonitorEvent["model"]>["role"]>> = {
    implementation: "implementation",
    fixer: "fix",
    "ci-repair": "fix",
    "self-review": "review",
    "correctness-review": "review",
    "tests-review": "review",
    "architecture-review": "review",
    "security-review": "review",
    "summarization-status": "summary",
    planning: "other"
  };
  return roles[role as ModelRoutingRole] ?? "other";
}

function isMonitorKind(value: unknown): value is MonitorEventKind {
  return typeof value === "string" && [
    "run_started", "run_finished", "run_failed", "stage_started", "stage_finished", "step_started", "step_finished", "wait_started", "wait_finished", "loop_started", "loop_finished", "loop_iteration_started", "loop_iteration_finished", "model_started", "model_finished", "validation_started", "validation_finished", "human_action_required"
  ].includes(value);
}

function isMonitorStatus(value: unknown): value is MonitorEventStatus {
  return value === "active" || value === "done" || value === "failed" || value === "waiting" || value === "pass" || value === "skipped";
}

function isMonitorTimeClass(value: unknown): value is MonitorTimeClass {
  return value === "agent" || value === "validation" || value === "scheduler" || value === "external-wait" || value === "human-wait" || value === "tool";
}

function monitorHumanAction(value: unknown): MonitorEvent["humanAction"] | undefined {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const reasonCode = isMonitorReasonCode(record.reasonCode) ? record.reasonCode : undefined;
  const changedSurfaces = stringList(record.changedSurfaces).filter(isMonitorChangedSurface);
  const changedFiles = stringList(record.changedFiles);
  const details = typeof record.details === "string" ? record.details : undefined;
  if (!reasonCode && changedSurfaces.length === 0 && changedFiles.length === 0 && !details) return undefined;
  return {
    ...(reasonCode ? { reasonCode } : {}),
    ...(changedSurfaces.length ? { changedSurfaces } : {}),
    ...(changedFiles.length ? { changedFiles } : {}),
    ...(details ? { details } : {})
  };
}

function isMonitorReasonCode(value: unknown): value is NonNullable<MonitorEvent["humanAction"]>["reasonCode"] {
  return (
    value === "none" ||
    value === "validation_failed" ||
    value === "ci_failed" ||
    value === "review_findings" ||
    value === "architecture_check_failed" ||
    value === "workflow_config_changed" ||
    value === "human_review" ||
    value === "needs_input" ||
    value === "planning_required" ||
    value === "recovery_needed" ||
    value === "blocked" ||
    value === "capacity_wait" ||
    value === "unknown"
  );
}

function isMonitorChangedSurface(value: string): value is NonNullable<NonNullable<MonitorEvent["humanAction"]>["changedSurfaces"]>[number] {
  return value === "docs" || value === "workflow-config" || value === "architecture-check" || value === "ui" || value === "tests" || value === "source" || value === "unknown";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "command";
}

function humanize(value: string): string {
  const spaced = value.replace(/[_/-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Activity";
}
