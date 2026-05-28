import { createHash } from "node:crypto";
import { buildMonitorActivity, type MonitorActivity } from "./monitor-contracts.js";
import type { RunPhaseTiming } from "./runs.js";
import type { AgentEvent, AgentRunResult, Issue, ModelRoutingRole } from "./types.js";
import type { ValidationEvidenceCheck } from "./validation.js";

type RunEventWriter = (runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }) => Promise<void>;

export async function writeTurnStartedMonitorEvent(input: {
  writeRunEvent: RunEventWriter;
  runId: string;
  issue: Issue;
  timing: RunPhaseTiming;
  label: string;
  current: number;
  max?: number;
}): Promise<void> {
  const spanId = `${input.timing.id}:step`;
  await input.writeRunEvent(input.runId, {
    type: "turn_started",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: input.label,
    timestamp: new Date().toISOString(),
    payload: {
      turnNumber: input.current,
      ...(input.max != null ? { maxTurns: input.max } : {}),
      monitor: {
        kind: "step_started",
        spanId,
        parentSpanId: input.timing.id,
        label: input.label,
        timeClass: "agent",
        iteration: { current: input.current, ...(input.max != null ? { max: input.max } : {}), label: "turn" }
      }
    }
  });
}

export function turnCompletedMonitorPayload(input: {
  timing: RunPhaseTiming;
  label: string;
  current: number;
  result: AgentRunResult;
  max?: number;
}): Record<string, unknown> {
  return {
    turnNumber: input.current,
    ...(input.max != null ? { maxTurns: input.max } : {}),
    result: input.result,
    monitor: {
      kind: "step_finished",
      spanId: `${input.timing.id}:step`,
      parentSpanId: input.timing.id,
      label: input.label,
      status: input.result.status === "succeeded" ? "done" : "failed",
      timeClass: "agent",
      iteration: { current: input.current, ...(input.max != null ? { max: input.max } : {}), label: "turn" },
      result: input.result.status
    }
  };
}

export async function writeTurnCompletedMonitorEvent(input: {
  writeRunEvent: RunEventWriter;
  runId: string;
  issue: Issue;
  timing: RunPhaseTiming;
  label: string;
  current: number;
  result: AgentRunResult;
  max?: number;
  displayResult?: AgentRunResult;
  message?: string;
}): Promise<void> {
  const eventResult = input.displayResult ?? input.result;
  await input.writeRunEvent(input.runId, {
    type: "turn_completed",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: input.message ?? `${input.label} ${eventResult.status}`,
    payload: turnCompletedMonitorPayload({ ...input, result: eventResult })
  });
}

export function withRunnerActivityMonitorContext(event: AgentEvent, timing: RunPhaseTiming): AgentEvent {
  const monitor = runnerActivityMonitorPayload(event, timing);
  if (!monitor) return event;
  if (typeof event.payload !== "object" || event.payload == null || Array.isArray(event.payload)) return event;
  return { ...event, payload: { ...event.payload, monitor } };
}

export function runnerActivityMonitorPayload(event: AgentEvent, timing: RunPhaseTiming): Record<string, unknown> | null {
  const commandRow = runnerCommandRowFromEvent(event, timing);
  if (commandRow) return commandRow;
  const activity = runnerActivityFromEvent(event);
  if (!activity) return null;
  const turnId = runnerTurnId(event);
  return {
    kind: "activity_observed",
    spanId: `${timing.id}:step`,
    parentSpanId: timing.id,
    ...(turnId ? { turnId } : {}),
    label: activity.label,
    timeClass: "agent",
    activity
  };
}

function runnerCommandRowFromEvent(event: AgentEvent, timing: RunPhaseTiming): Record<string, unknown> | null {
  if (event.type !== "item/started" && event.type !== "item/completed") return null;
  const item = runnerItem(event);
  if (item?.type !== "commandExecution") return null;
  const command = compactRunnerString(item.command);
  const activity = buildMonitorActivity({
    kind: "command_output",
    label: "Command execution",
    ...(command ? { command } : {}),
    ...(event.type === "item/completed" && typeof item.output === "string" ? { bytesObserved: Buffer.byteLength(item.output) } : {})
  });
  const commandLabel = activity.kind === "command_output" ? activity.command : undefined;
  const status = commandStatus(event.type, item);
  const result = commandResult(event.type, item);
  return {
    kind: event.type === "item/started" ? "step_started" : "step_finished",
    spanId: commandSpanId(timing.id, item, command),
    parentSpanId: `${timing.id}:step`,
    ...(runnerTurnId(event) ? { turnId: runnerTurnId(event) } : {}),
    label: `Command: ${commandLabel ?? "command execution"}`,
    status,
    timeClass: "tool",
    activity,
    ...(result ? { result } : {})
  };
}

export async function writeModelFinishedMonitorEvent(input: {
  writeRunEvent: RunEventWriter;
  runId: string;
  issue: Issue;
  result: AgentRunResult;
  role: ModelRoutingRole;
  attempt: number;
  displayStatus?: AgentRunResult["status"];
}): Promise<void> {
  if (!input.result.modelTelemetry) return;
  await input.writeRunEvent(input.runId, {
    type: "model_finished",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: `${input.role} model finished`,
    payload: { ...input.result.modelTelemetry, role: input.role, attempt: input.attempt, status: input.displayStatus ?? input.result.status }
  });
}

export async function writeValidationCommandMonitorEvents(input: {
  writeRunEvent: RunEventWriter;
  runId: string;
  issue: Issue;
  validation: ValidationEvidenceCheck;
}): Promise<void> {
  const commands = input.validation.evidence?.commands ?? [];
  for (const [index, command] of commands.entries()) {
    const spanId = `${input.runId}:validation:${index}`;
    await input.writeRunEvent(input.runId, {
      type: "validation_command_started",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: command.name,
      timestamp: command.startedAt,
      payload: {
        index,
        command: command.name,
        startedAt: command.startedAt,
        monitor: {
          kind: "validation_started",
          spanId,
          label: `Validation command: ${command.name}`,
          timeClass: "validation",
          validation: { command: command.name, status: "skipped" }
        }
      }
    });
    await input.writeRunEvent(input.runId, {
      type: "validation_command_finished",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: command.name,
      timestamp: command.finishedAt,
      payload: {
        index,
        command: command.name,
        exitCode: command.exitCode,
        status: command.exitCode === 0 ? "passed" : "failed",
        startedAt: command.startedAt,
        finishedAt: command.finishedAt,
        monitor: {
          kind: "validation_finished",
          spanId,
          label: `Validation command: ${command.name}`,
          status: command.exitCode === 0 ? "pass" : "failed",
          timeClass: "validation",
          validation: {
            command: command.name,
            durationMs: Math.max(0, Date.parse(command.finishedAt) - Date.parse(command.startedAt)),
            status: command.exitCode === 0 ? "pass" : "fail",
            exitCode: command.exitCode
          },
          result: command.exitCode === 0 ? "pass" : "fail"
        }
      }
    });
  }
}

export function reviewIterationStartedMonitorEvent(input: {
  runId?: string;
  issue: Issue;
  iteration: number;
  maxIterations: number;
  prUrls: string[];
  reviewers: string[];
  reviewerConcurrency: number;
  parallelReviewers: boolean;
}): Omit<AgentEvent, "timestamp"> {
  return {
    type: "review_started",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: `review iteration ${input.iteration}`,
    payload: {
      prUrls: input.prUrls,
      reviewers: input.reviewers,
      reviewerConcurrency: input.reviewerConcurrency,
      mode: input.parallelReviewers ? "parallel" : "sequential",
      iteration: input.iteration,
      maxIterations: input.maxIterations,
      monitor: {
        kind: "loop_iteration_started",
        spanId: `${input.runId ?? "review"}:automated-review:loop:${input.iteration}`,
        parentSpanId: input.runId ? `${input.runId}:automated-review:loop` : undefined,
        label: `review iteration ${input.iteration}`,
        timeClass: "agent",
        iteration: { current: input.iteration, max: input.maxIterations, label: "review iteration" }
      }
    }
  };
}

export function reviewIterationFinishedMonitorEvent(input: {
  runId?: string;
  issue: Issue;
  iteration: number;
  maxIterations: number;
  status: string;
  message: string;
  blocking: number;
  repeated: string[];
}): Omit<AgentEvent, "timestamp"> {
  return {
    type: input.status === "approved" ? "review_approved" : "review_iteration_complete",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: input.message,
    payload: {
      blocking: input.blocking,
      repeated: input.repeated,
      iteration: input.iteration,
      maxIterations: input.maxIterations,
      monitor: {
        kind: "loop_iteration_finished",
        spanId: `${input.runId ?? "review"}:automated-review:loop:${input.iteration}`,
        parentSpanId: input.runId ? `${input.runId}:automated-review:loop` : undefined,
        label: `review iteration ${input.iteration}`,
        status: input.status === "approved" ? "done" : "failed",
        timeClass: "agent",
        iteration: { current: input.iteration, max: input.maxIterations, label: "review iteration" },
        result: input.status
      }
    }
  };
}

function runnerActivityFromEvent(event: AgentEvent): MonitorActivity | null {
  if (event.type === "codex_stdout") {
    return buildMonitorActivity({
      kind: "command_output",
      label: "Runner stdout observed",
      stream: "stdout",
      bytesObserved: bytesObserved(event)
    });
  }
  if (event.type === "codex_stderr" || event.type === "codex_stderr_benign") {
    return buildMonitorActivity({
      kind: "command_output",
      label: event.type === "codex_stderr_benign" ? "Runner stderr warning observed" : "Runner stderr observed",
      stream: "stderr",
      bytesObserved: bytesObserved(event)
    });
  }
  if (event.type === "thread/tokenUsage/updated") {
    const usage = runnerTokenUsage(event);
    return usage ? buildMonitorActivity({ kind: "token_usage", label: "Runner token usage observed", ...usage }) : null;
  }
  if (event.type === "account/rateLimits/updated") {
    const rateLimit = runnerRateLimit(event);
    return buildMonitorActivity({ kind: "rate_limit", label: "Runner rate-limit pressure observed", ...rateLimit });
  }
  if (event.type === "item/started" || event.type === "item/completed") {
    const item = runnerItem(event);
    const action = event.type === "item/started" ? "started" : "completed";
    if (item?.type === "commandExecution") {
      return buildMonitorActivity({
        kind: "command_output",
        label: `Runner command ${action}`,
        ...(typeof item.command === "string" ? { command: item.command } : {}),
        ...(event.type === "item/completed" && typeof item.output === "string" ? { bytesObserved: Buffer.byteLength(item.output) } : {})
      });
    }
    return buildMonitorActivity({ kind: "generic", label: `Runner item ${action}` });
  }
  return null;
}

function bytesObserved(event: AgentEvent): number | undefined {
  const payload = recordValue(event.payload);
  const captured = integerValue(payload?.capturedChars);
  if (captured != null) return captured;
  return event.message ? Buffer.byteLength(event.message) : undefined;
}

function runnerTokenUsage(event: AgentEvent): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null {
  const params = recordValue(recordValue(event.payload)?.params);
  const usage = recordValue(recordValue(params?.tokenUsage)?.total) ?? recordValue(params?.tokenUsage) ?? recordValue(params?.usage);
  if (!usage) return null;
  const inputTokens = integerValue(usage.inputTokens ?? usage.input_tokens ?? usage.input);
  const outputTokens = integerValue(usage.outputTokens ?? usage.output_tokens ?? usage.output);
  const totalTokens = integerValue(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  if (inputTokens == null && outputTokens == null && totalTokens == null) return null;
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(totalTokens != null ? { totalTokens } : {})
  };
}

function runnerRateLimit(event: AgentEvent): { pressure: "none" | "low" | "medium" | "high" | "blocked"; resetAt?: string } {
  const params = recordValue(recordValue(event.payload)?.params);
  const snapshot = recordValue(params?.rateLimits) ?? recordValue(params?.rateLimit);
  const usedPercent = maxNumberByKey(snapshot, "usedPercent");
  const remainingPercent = maxNumberByKey(snapshot, "remainingPercent");
  const pressure =
    usedPercent != null ? pressureFromUsedPercent(usedPercent) : remainingPercent != null ? pressureFromRemainingPercent(remainingPercent) : "none";
  const resetAt = firstStringByKey(snapshot, "resetAt") ?? firstStringByKey(snapshot, "reset_at");
  return {
    pressure,
    ...(resetAt ? { resetAt } : {})
  };
}

function runnerItem(event: AgentEvent): Record<string, unknown> | null {
  return recordValue(recordValue(recordValue(event.payload)?.params)?.item);
}

function runnerTurnId(event: AgentEvent): string | undefined {
  const payload = recordValue(event.payload);
  const params = recordValue(payload?.params);
  const value = params?.turnId ?? params?.turn_id ?? recordValue(params?.turn)?.id ?? payload?.turnId ?? payload?.turn_id;
  return compactRunnerString(value);
}

function pressureFromUsedPercent(value: number): "none" | "low" | "medium" | "high" | "blocked" {
  const normalized = value > 1 ? value / 100 : value;
  if (normalized >= 1) return "blocked";
  if (normalized >= 0.9) return "high";
  if (normalized >= 0.75) return "medium";
  return normalized > 0 ? "low" : "none";
}

function pressureFromRemainingPercent(value: number): "none" | "low" | "medium" | "high" | "blocked" {
  const normalized = value > 1 ? value / 100 : value;
  if (normalized <= 0) return "blocked";
  if (normalized <= 0.1) return "high";
  if (normalized <= 0.25) return "medium";
  return normalized < 1 ? "low" : "none";
}

function maxNumberByKey(value: unknown, key: string): number | undefined {
  const matches: number[] = [];
  visitRecords(value, (record) => {
    const numeric = numberValue(record[key]);
    if (numeric != null) matches.push(numeric);
  });
  return matches.length ? Math.max(...matches) : undefined;
}

function firstStringByKey(value: unknown, key: string): string | undefined {
  let match: string | undefined;
  visitRecords(value, (record) => {
    if (!match) match = compactRunnerString(record[key]);
  });
  return match;
}

function visitRecords(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  const record = recordValue(value);
  if (!record) return;
  visit(record);
  for (const child of Object.values(record)) {
    if (typeof child === "object" && child != null) visitRecords(child, visit);
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function integerValue(value: unknown): number | undefined {
  const numeric = numberValue(value);
  return numeric != null && Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactRunnerString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

function commandStatus(type: string, item: Record<string, unknown>): "active" | "done" | "failed" | "pass" {
  if (type === "item/started") return "active";
  const exitCode = integerValue(item.exitCode);
  if (exitCode === 0) return "pass";
  if (exitCode != null && exitCode !== 0) return "failed";
  const rawStatus = compactRunnerString(item.status)?.toLowerCase();
  if (rawStatus === "failed" || rawStatus === "error") return "failed";
  if (rawStatus === "passed" || rawStatus === "success" || rawStatus === "succeeded") return "pass";
  return "done";
}

function commandResult(type: string, item: Record<string, unknown>): string | undefined {
  if (type === "item/started") return "running";
  const exitCode = integerValue(item.exitCode);
  if (exitCode != null) return `exit ${exitCode}`;
  return compactRunnerString(item.status);
}

function commandSpanId(parentId: string, item: Record<string, unknown>, command: string | undefined): string {
  const itemId = compactRunnerString(item.id ?? item.itemId);
  if (itemId) return `${parentId}:command:${safeSpanSegment(itemId)}`;
  const hash = createHash("sha256").update(command ?? "unknown-command").digest("hex").slice(0, 12);
  return `${parentId}:command:${hash}`;
}

function safeSpanSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || createHash("sha256").update(value).digest("hex").slice(0, 12);
}
