export type MonitorTimeClass = "agent" | "validation" | "scheduler" | "external-wait" | "human-wait" | "tool";
export type MonitorStatus = "active" | "done" | "failed" | "waiting" | "pass" | "skipped";

export type MonitorSink = {
  emit(event: MonitorEvent): void | Promise<void>;
};

export class NullMonitorSink implements MonitorSink {
  emit(_event: MonitorEvent): void {}
}

export type MonitorEvent = {
  eventId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  issueId?: string;
  timestamp: string;
  kind:
    | "run_started"
    | "run_finished"
    | "run_failed"
    | "stage_started"
    | "stage_finished"
    | "step_started"
    | "step_finished"
    | "wait_started"
    | "wait_finished"
    | "loop_started"
    | "loop_finished"
    | "loop_iteration_started"
    | "loop_iteration_finished"
    | "model_started"
    | "model_finished"
    | "validation_started"
    | "validation_finished"
    | "human_action_required";
  label: string;
  status?: MonitorStatus;
  timeClass?: MonitorTimeClass;
  model?: { name: string; role: "implementation" | "review" | "fix" | "summary" | "validation" | "other" };
  iteration?: { current: number; max?: number; label: string };
  result?: string;
};
