import type { AgentRunResult } from "./types.js";
import type { RunPhaseTiming, RunSummary, RunTimingPhase, RunTimingState, RunTimingStatus } from "./runs.js";

export function withTiming(summary: RunSummary, phases: RunPhaseTiming[], updatedAt: string): RunSummary {
  return {
    ...summary,
    timing: {
      updatedAt,
      phases
    }
  };
}

export function findOpenPhaseIndex(phases: RunPhaseTiming[], match: { id?: string; phase?: RunTimingPhase }): number {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (isOpenPhaseMatch(phase, match)) return index;
  }
  return -1;
}

export function isOpenPhaseMatch(phase: RunPhaseTiming, match: { id?: string; phase?: RunTimingPhase }): boolean {
  if (phase.finishedAt) return false;
  if (match.id && phase.id !== match.id) return false;
  if (match.phase && phase.phase !== match.phase) return false;
  return true;
}

export function findLatestPhaseIndex(phases: RunPhaseTiming[], match: { id?: string; phase?: RunTimingPhase }): number {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (match.id && phase.id !== match.id) continue;
    if (match.phase && phase.phase !== match.phase) continue;
    return index;
  }
  return -1;
}

export function finishPhaseTiming(
  phase: RunPhaseTiming,
  finishedAt: string,
  status: Exclude<RunTimingStatus, "running">,
  metadata?: Record<string, unknown>
): RunPhaseTiming {
  return compactPhaseTiming({
    ...phase,
    status,
    finishedAt,
    durationMs: durationMs(phase.startedAt, finishedAt),
    metadata: {
      ...(phase.metadata ?? {}),
      ...(metadata ?? {})
    }
  });
}

export function finalizeRunTiming(
  summary: RunSummary,
  result: AgentRunResult,
  finishedAt: string
): { timing: RunTimingState | undefined; syntheticPhase: RunPhaseTiming | null; finalizedPhases: RunPhaseTiming[] } {
  const terminalStatus = terminalTimingStatus(result.status);
  const finalizedPhases: RunPhaseTiming[] = [];
  const phases = (summary.timing?.phases ?? []).map((phase) => {
    if (phase.finishedAt || phase.status === "waiting") return phase;
    const finished = finishPhaseTiming(phase, finishedAt, terminalStatus);
    finalizedPhases.push(finished);
    return finished;
  });
  let syntheticPhase: RunPhaseTiming | null = null;
  if ((result.status === "stale" || result.status === "stalled" || result.status === "canceled") && !phases.some((phase) => phase.phase === "stall-cancel" && phase.finishedAt)) {
    syntheticPhase = compactPhaseTiming({
      id: `stall-cancel-${phases.length + 1}`,
      phase: "stall-cancel",
      status: result.status === "canceled" ? "canceled" : "stalled",
      startedAt: summary.lastEventAt ?? summary.startedAt,
      finishedAt,
      durationMs: durationMs(summary.lastEventAt ?? summary.startedAt, finishedAt),
      metadata: result.error ? { reason: result.error } : undefined
    });
    phases.push(syntheticPhase);
  }
  if (phases.length === 0) return { timing: summary.timing, syntheticPhase, finalizedPhases };
  return {
    timing: {
      updatedAt: finishedAt,
      phases
    },
    syntheticPhase,
    finalizedPhases
  };
}

export function compactPhaseTiming<T extends RunPhaseTiming>(entry: T): T {
  const next = { ...entry };
  if (!next.label) delete next.label;
  if (next.durationMs == null) delete next.durationMs;
  if (!next.metadata || Object.keys(next.metadata).length === 0) delete next.metadata;
  return next;
}

function terminalTimingStatus(status: AgentRunResult["status"]): Exclude<RunTimingStatus, "running"> {
  if (status === "succeeded") return "completed";
  if (status === "canceled") return "canceled";
  if (status === "stale" || status === "stalled") return "stalled";
  return "failed";
}

function durationMs(startedAt: string, finishedAt: string): number | undefined {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  return Math.max(0, finished - started);
}
