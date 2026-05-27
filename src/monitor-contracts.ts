export type MonitorTimeClass = "agent" | "validation" | "scheduler" | "external-wait" | "human-wait" | "tool";
export type MonitorStatus = "active" | "done" | "failed" | "waiting" | "pass" | "skipped";
export type MonitorValidationStatus = "pass" | "fail" | "skipped";
export type MonitorChangedSurface = "docs" | "workflow-config" | "architecture-check" | "ui" | "tests" | "source" | "unknown";
export const monitorActivityKinds = ["command_output", "file_change", "token_usage", "rate_limit", "generic"] as const;
export type MonitorActivityKind = (typeof monitorActivityKinds)[number];
export type MonitorRateLimitPressure = "none" | "low" | "medium" | "high" | "blocked";
export type MonitorHumanActionReasonCode =
  | "none"
  | "validation_failed"
  | "ci_failed"
  | "review_findings"
  | "architecture_check_failed"
  | "workflow_config_changed"
  | "human_review"
  | "needs_input"
  | "planning_required"
  | "recovery_needed"
  | "blocked"
  | "capacity_wait"
  | "unknown";

export type MonitorActivity =
  | {
      kind: "command_output";
      label: string;
      command?: string;
      stream?: "stdout" | "stderr";
      bytesObserved?: number;
    }
  | {
      kind: "file_change";
      label: string;
      changedFileCount?: number;
      lastFile?: string;
      category?: "source" | "test" | "docs" | "config" | "unknown";
    }
  | {
      kind: "token_usage";
      label: string;
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      kind: "rate_limit";
      label: string;
      pressure: MonitorRateLimitPressure;
      resetAt?: string;
    }
  | {
      kind: "generic";
      label: string;
    };

export type MonitorActivityInput = Record<string, unknown> & {
  kind: MonitorActivityKind;
};

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
  turnId?: string;
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
    | "activity_observed"
    | "human_action_required";
  label: string;
  status?: MonitorStatus;
  timeClass?: MonitorTimeClass;
  model?: { name: string; role: "implementation" | "review" | "fix" | "summary" | "validation" | "other" };
  iteration?: { current: number; max?: number; label: string };
  validation?: { command: string; durationMs?: number; status: MonitorValidationStatus; exitCode?: number };
  humanAction?: {
    reasonCode?: MonitorHumanActionReasonCode;
    changedSurfaces?: MonitorChangedSurface[];
    changedFiles?: string[];
    details?: string;
  };
  activity?: MonitorActivity;
  result?: string;
};

export function buildMonitorActivity(input: MonitorActivityInput): MonitorActivity {
  const label = compactActivityString(input.label) ?? defaultActivityLabel(input.kind);
  if (input.kind === "command_output") {
    return {
      kind: input.kind,
      label,
      ...(compactActivityString(input.command) ? { command: compactActivityString(input.command) } : {}),
      ...(monitorActivityStream(input.stream) ? { stream: monitorActivityStream(input.stream) } : {}),
      ...(nonNegativeInteger(input.bytesObserved ?? input.byteCount) != null ? { bytesObserved: nonNegativeInteger(input.bytesObserved ?? input.byteCount)! } : {})
    };
  }
  if (input.kind === "file_change") {
    return {
      kind: input.kind,
      label,
      ...(nonNegativeInteger(input.changedFileCount ?? input.fileCount) != null ? { changedFileCount: nonNegativeInteger(input.changedFileCount ?? input.fileCount)! } : {}),
      ...(repoRelativeActivityPath(input.lastFile ?? input.path) ? { lastFile: repoRelativeActivityPath(input.lastFile ?? input.path) } : {}),
      ...(monitorFileCategory(input.category) ? { category: monitorFileCategory(input.category) } : {})
    };
  }
  if (input.kind === "token_usage") {
    return {
      kind: input.kind,
      label,
      ...(nonNegativeInteger(input.totalTokens) != null ? { totalTokens: nonNegativeInteger(input.totalTokens)! } : {}),
      ...(nonNegativeInteger(input.inputTokens) != null ? { inputTokens: nonNegativeInteger(input.inputTokens)! } : {}),
      ...(nonNegativeInteger(input.outputTokens) != null ? { outputTokens: nonNegativeInteger(input.outputTokens)! } : {})
    };
  }
  if (input.kind === "rate_limit") {
    return {
      kind: input.kind,
      label,
      pressure: monitorRateLimitPressure(input.pressure) ?? "none",
      ...(compactActivityString(input.resetAt) ? { resetAt: compactActivityString(input.resetAt) } : {})
    };
  }
  return {
    kind: input.kind,
    label
  };
}

function compactActivityString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return redactKnownEnvValues(trimmed).slice(0, 160);
}

function redactKnownEnvValues(value: string): string {
  let redacted = value;
  for (const [key, envValue] of Object.entries(process.env)) {
    if (!envValue || envValue.length < 8 || !/(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|PRIVATE_KEY)/i.test(key)) continue;
    redacted = redacted.split(envValue).join("[REDACTED]");
  }
  return redacted;
}

function defaultActivityLabel(kind: MonitorActivityKind): string {
  if (kind === "command_output") return "Command output observed";
  if (kind === "file_change") return "File activity observed";
  if (kind === "token_usage") return "Token usage observed";
  if (kind === "rate_limit") return "Rate-limit pressure observed";
  return "Activity observed";
}

function monitorActivityStream(value: unknown): "stdout" | "stderr" | undefined {
  return value === "stdout" || value === "stderr" ? value : undefined;
}

function monitorFileCategory(value: unknown): "source" | "test" | "docs" | "config" | "unknown" | undefined {
  return value === "source" || value === "test" || value === "docs" || value === "config" || value === "unknown" ? value : undefined;
}

function monitorRateLimitPressure(value: unknown): MonitorRateLimitPressure | undefined {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "blocked" ? value : undefined;
}

function repoRelativeActivityPath(value: unknown): string | undefined {
  const compact = compactActivityString(value);
  if (!compact || compact.startsWith("/") || compact.startsWith("~") || compact.includes("..")) return undefined;
  return compact;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = integerValue(value);
  return numeric != null && numeric >= 0 ? numeric : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) ? value : undefined;
}
