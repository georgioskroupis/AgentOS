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
}): Promise<void> {
  await input.writeRunEvent(input.runId, {
    type: "turn_completed",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: `${input.label} ${input.result.status}`,
    payload: turnCompletedMonitorPayload(input)
  });
}

export async function writeModelFinishedMonitorEvent(input: {
  writeRunEvent: RunEventWriter;
  runId: string;
  issue: Issue;
  result: AgentRunResult;
  role: ModelRoutingRole;
  attempt: number;
}): Promise<void> {
  if (!input.result.modelTelemetry) return;
  await input.writeRunEvent(input.runId, {
    type: "model_finished",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: `${input.role} model finished`,
    payload: { ...input.result.modelTelemetry, role: input.role, attempt: input.attempt, status: input.result.status }
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
