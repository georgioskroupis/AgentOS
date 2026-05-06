import type { Issue, AgentRunResult } from "./types.js";
import type { RunArtifactStore, RunTimingPhase, RunTimingStatus } from "./runs.js";
import type { ValidationEvidenceCheck } from "./validation.js";

export interface PhaseTimingEventInput {
  phase: RunTimingPhase;
  status: RunTimingStatus;
  startedAt?: string;
  finishedAt?: string;
  label?: string;
  metadata?: Record<string, unknown>;
  runId?: string | null;
}

export interface ResolvedPhaseTimingEventInput extends PhaseTimingEventInput {
  startedAt: string;
}

export function phaseTimingLogPayload(input: ResolvedPhaseTimingEventInput): Record<string, unknown> {
  return compactTimingEvent({
    phase: input.phase,
    status: input.status,
    label: input.label,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.finishedAt ? timingDurationMs(input.startedAt, input.finishedAt) : undefined,
    metadata: input.metadata
  });
}

export async function persistPhaseTimingToRun(
  store: RunArtifactStore,
  runId: string,
  issue: Issue,
  input: ResolvedPhaseTimingEventInput,
  options: { activeRunId?: string | null } = {}
): Promise<void> {
  const finishedStatus: Exclude<RunTimingStatus, "running"> = input.status === "running" ? "completed" : input.status;
  if (input.finishedAt && input.status !== "waiting") {
    const closed = await store.finishPhase(runId, { phase: input.phase }, { status: finishedStatus, finishedAt: input.finishedAt, metadata: input.metadata });
    if (closed) {
      await store.writeEvent(runId, {
        type: "phase_finished",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: closed.label ?? closed.phase,
        timestamp: closed.finishedAt ?? input.finishedAt,
        payload: { timing: closed }
      });
      await refreshRunHashesIfInactive(store, runId, options.activeRunId);
      return;
    }
  }

  const startStatus: Extract<RunTimingStatus, "running" | "waiting"> = input.status === "waiting" ? "waiting" : "running";
  const startInput = {
    phase: input.phase,
    label: input.label,
    startedAt: input.startedAt,
    status: startStatus,
    metadata: input.metadata
  };
  const { phase: started, created } =
    input.status === "waiting" && !input.finishedAt ? await store.startOrUpdateOpenPhase(runId, startInput) : { phase: await store.startPhase(runId, startInput), created: true };
  if (created) {
    await store.writeEvent(runId, {
      type: "phase_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: started.label ?? started.phase,
      timestamp: started.startedAt,
      payload: { timing: started }
    });
  }

  if (input.finishedAt) {
    const finished = await store.finishPhase(runId, { id: started.id }, { status: finishedStatus, finishedAt: input.finishedAt, metadata: input.metadata });
    if (finished) {
      await store.writeEvent(runId, {
        type: "phase_finished",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        message: finished.label ?? finished.phase,
        timestamp: finished.finishedAt ?? input.finishedAt,
        payload: { timing: finished }
      });
    }
  }
  await refreshRunHashesIfInactive(store, runId, options.activeRunId);
}

export function timingStatusForRunResult(result: AgentRunResult): Exclude<RunTimingStatus, "running"> {
  if (result.status === "succeeded") return "completed";
  if (result.status === "canceled") return "canceled";
  if (result.status === "stale" || result.status === "stalled") return "stalled";
  return "failed";
}

export function validationTimingFromEvidence(
  validation: ValidationEvidenceCheck,
  fallbackStartedAt: string,
  fallbackFinishedAt: string
): {
  startedAt: string;
  finishedAt: string;
  label: string;
  metadata: Record<string, unknown>;
} {
  const baseMetadata = {
    status: validation.state.status,
    path: validation.state.path,
    finalStatus: validation.state.finalStatus,
    commandCount: validation.evidence?.commands?.length ?? 0,
    acceptedCommandCount: validation.state.acceptedCommands?.length ?? 0,
    failedHistoricalAttemptCount: validation.state.failedHistoricalAttempts?.length ?? 0
  };
  const finalResult = validation.evidence?.finalResult;
  const finalInterval = validTimingInterval(finalResult?.startedAt, finalResult?.finishedAt);
  if (finalInterval) {
    return {
      ...finalInterval,
      label: "validation final result",
      metadata: {
        ...baseMetadata,
        timingSource: "finalResult",
        finalResultHasCommand: Boolean(finalResult?.command),
        exitCode: finalResult?.exitCode
      }
    };
  }

  const commandIntervals = (validation.evidence?.commands ?? []).flatMap((command) => {
    const interval = validTimingInterval(command.startedAt, command.finishedAt);
    return interval ? [{ name: command.name, interval }] : [];
  });
  if (commandIntervals.length > 0) {
    const startedAt = commandIntervals.reduce((earliest, command) => (command.interval.startedMs < earliest.startedMs ? command.interval : earliest), commandIntervals[0].interval).startedAt;
    const finishedAt = commandIntervals.reduce((latest, command) => (command.interval.finishedMs > latest.finishedMs ? command.interval : latest), commandIntervals[0].interval).finishedAt;
    return {
      startedAt,
      finishedAt,
      label: "validation commands",
      metadata: {
        ...baseMetadata,
        timingSource: "commands",
        timedCommandCount: commandIntervals.length
      }
    };
  }

  return {
    startedAt: fallbackStartedAt,
    finishedAt: fallbackFinishedAt,
    label: "validation evidence verification",
    metadata: {
      ...baseMetadata,
      timingSource: "evidence-verification"
    }
  };
}

async function refreshRunHashesIfInactive(store: RunArtifactStore, runId: string, activeRunId?: string | null): Promise<void> {
  if (activeRunId === runId) return;
  await store.refreshArtifactHashes(runId);
}

function validTimingInterval(startedAt: string | null | undefined, finishedAt: string | null | undefined): { startedAt: string; finishedAt: string; startedMs: number; finishedMs: number } | null {
  if (!startedAt || !finishedAt) return null;
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || startedMs > finishedMs) return null;
  return { startedAt, finishedAt, startedMs, finishedMs };
}

function timingDurationMs(startedAt: string, finishedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  return Math.max(0, finished - started);
}

export function timingStartNoLaterThan(startedAt: string | null | undefined, finishedAt: string): string {
  if (!startedAt) return finishedAt;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || started > finished) return finishedAt;
  return startedAt;
}

function compactTimingEvent<T extends { label?: string; durationMs?: number; metadata?: Record<string, unknown> }>(event: T): T {
  const next = { ...event };
  if (!next.label) delete next.label;
  if (next.durationMs == null) delete next.durationMs;
  if (!next.metadata || Object.keys(next.metadata).length === 0) delete next.metadata;
  return next;
}
