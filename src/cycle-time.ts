import type { RunPhaseTiming, RunSummary, RunTimingPhase, RunTimingStatus } from "./runs.js";

const STALL_RETRY_WARNING_MS = 10 * 60 * 1000;
const STALL_RETRY_WARNING_RATIO = 0.25;
const REVIEW_WARNING_MS = 30 * 60 * 1000;
const REVIEW_SERIAL_WARNING_MS = 15 * 60 * 1000;
const REVIEW_WARNING_RATIO = 0.4;
const HUMAN_WAIT_WARNING_MS = 4 * 60 * 60 * 1000;
const OPEN_HUMAN_WAIT_WARNING_MS = 60 * 60 * 1000;
const MERGE_RETRY_WARNING_MS = 30 * 60 * 1000;

interface CycleTimeOptions {
  now?: string;
}

interface PhaseAggregate {
  phase: RunTimingPhase;
  count: number;
  durationMs: number;
  openCount: number;
  firstStartedMs: number;
  statuses: Map<RunTimingStatus, number>;
}

interface CycleWarning {
  message: string;
  nextAction: string;
}

interface CycleSummary {
  totalMs: number;
  measuredMs: number;
  phases: PhaseAggregate[];
  warnings: CycleWarning[];
}

export function formatRunCycleDiagnostics(summary: RunSummary, options: CycleTimeOptions = {}): string {
  const cycle = summarizeRunCycleTime(summary, options);
  if (cycle.phases.length === 0) {
    return [
      "Cycle time: no phase timing recorded",
      "SLO diagnostics: unavailable - run predates phase timing or no phase events were captured",
      "Next actions:",
      "- inspect run events and validation artifacts; future runs should emit phase timing"
    ].join("\n");
  }

  const lines = [
    "Cycle time:",
    `- total: ${formatDuration(cycle.totalMs)} (measured phases: ${formatDuration(cycle.measuredMs)})`,
    ...cycle.phases.map((phase) => `- ${phase.phase}: ${formatDuration(phase.durationMs)} (${phaseStatusSummary(phase)})`)
  ];

  if (cycle.warnings.length === 0) {
    lines.push("SLO diagnostics: healthy", "Next actions:", "- no cycle-time action needed; continue with normal validation and handoff checks");
    return lines.join("\n");
  }

  lines.push("SLO diagnostics:");
  for (const warning of cycle.warnings) {
    lines.push(`- ${warning.message}`, `  Next action: ${warning.nextAction}`);
  }
  return lines.join("\n");
}

function summarizeRunCycleTime(summary: RunSummary, options: CycleTimeOptions): CycleSummary {
  const referenceAt = options.now ?? new Date().toISOString();
  const phases = aggregatePhases(summary.timing?.phases ?? [], referenceAt);
  const measuredMs = phases.reduce((total, phase) => total + phase.durationMs, 0);
  const totalMs = runTotalMs(summary, summary.timing?.phases ?? [], referenceAt, measuredMs);
  return {
    totalMs,
    measuredMs,
    phases,
    warnings: cycleWarnings(phases, Math.max(totalMs, measuredMs, 1))
  };
}

function aggregatePhases(phases: RunPhaseTiming[], referenceAt: string): PhaseAggregate[] {
  const byPhase = new Map<RunTimingPhase, PhaseAggregate>();
  for (const phase of phases) {
    const aggregate = byPhase.get(phase.phase) ?? {
      phase: phase.phase,
      count: 0,
      durationMs: 0,
      openCount: 0,
      firstStartedMs: Number.POSITIVE_INFINITY,
      statuses: new Map<RunTimingStatus, number>()
    };
    aggregate.count += 1;
    aggregate.durationMs += phaseDurationMs(phase, referenceAt);
    if (!phase.finishedAt) aggregate.openCount += 1;
    aggregate.firstStartedMs = Math.min(aggregate.firstStartedMs, phaseStartedMs(phase));
    aggregate.statuses.set(phase.status, (aggregate.statuses.get(phase.status) ?? 0) + 1);
    byPhase.set(phase.phase, aggregate);
  }
  return [...byPhase.values()].sort((left, right) => left.firstStartedMs - right.firstStartedMs || left.phase.localeCompare(right.phase));
}

function cycleWarnings(phases: PhaseAggregate[], totalMs: number): CycleWarning[] {
  const warnings: CycleWarning[] = [];
  const stallRetryMs = phaseDuration(phases, ["stall-cancel", "retry-backoff"]);
  const stallRetryRatio = stallRetryMs / totalMs;
  if (stallRetryMs >= STALL_RETRY_WARNING_MS || stallRetryRatio >= STALL_RETRY_WARNING_RATIO) {
    warnings.push({
      message: `excessive stall/retry overhead: ${formatDuration(stallRetryMs)} (${formatPercent(stallRetryRatio)} of cycle time)`,
      nextAction: "inspect stall timeout, app logs, and retry queue; repair the deterministic blocker before redispatching"
    });
  }

  const reviewMs = phaseDuration(phases, ["automated-review", "fixer-turn"]);
  const reviewCount = phaseCount(phases, ["automated-review", "fixer-turn"]);
  const reviewRatio = reviewMs / totalMs;
  if (reviewMs >= REVIEW_WARNING_MS || (reviewCount > 1 && reviewMs >= REVIEW_SERIAL_WARNING_MS && reviewRatio >= REVIEW_WARNING_RATIO)) {
    warnings.push({
      message: `long serial review time: ${formatDuration(reviewMs)} across ${reviewCount} review/fix span${reviewCount === 1 ? "" : "s"}`,
      nextAction: "inspect review artifacts, resolve repeated findings, and split follow-up work before another fixer turn"
    });
  }

  const humanWaitMs = phaseDuration(phases, ["human-wait", "needs-input"]);
  const humanOpen = phaseOpenCount(phases, ["human-wait", "needs-input"]);
  if (humanWaitMs >= HUMAN_WAIT_WARNING_MS || (humanOpen > 0 && humanWaitMs >= OPEN_HUMAN_WAIT_WARNING_MS)) {
    warnings.push({
      message: `long human-wait: ${formatDuration(humanWaitMs)}${humanOpen > 0 ? " with an open wait" : ""}`,
      nextAction: "check decision comments, PR/CI evidence, and move forward only after structured human input or merge-ready evidence"
    });
  }

  const mergeCiPhases = ["merge-shepherding", "ci-wait"] satisfies RunTimingPhase[];
  const mergeRetryMs = phaseDuration(phases, [...mergeCiPhases, "retry-backoff"]);
  const mergeRetryHasDrift =
    phaseCount(phases, mergeCiPhases) > 0 &&
    mergeRetryMs >= MERGE_RETRY_WARNING_MS &&
    (phaseDuration(phases, ["retry-backoff"]) > 0 || phaseHasStatus(phases, mergeCiPhases, ["failed", "waiting"]));
  if (mergeRetryHasDrift) {
    warnings.push({
      message: `merge/retry drift: ${formatDuration(mergeRetryMs)} spent in merge, CI wait, or retry backoff`,
      nextAction: "inspect selected PR checks and durable merge/retry state before starting a new implementation run"
    });
  }

  return warnings;
}

function phaseDuration(phases: PhaseAggregate[], names: RunTimingPhase[]): number {
  return phases.filter((phase) => names.includes(phase.phase)).reduce((total, phase) => total + phase.durationMs, 0);
}

function phaseCount(phases: PhaseAggregate[], names: RunTimingPhase[]): number {
  return phases.filter((phase) => names.includes(phase.phase)).reduce((total, phase) => total + phase.count, 0);
}

function phaseOpenCount(phases: PhaseAggregate[], names: RunTimingPhase[]): number {
  return phases.filter((phase) => names.includes(phase.phase)).reduce((total, phase) => total + phase.openCount, 0);
}

function phaseHasStatus(phases: PhaseAggregate[], names: RunTimingPhase[], statuses: RunTimingStatus[]): boolean {
  return phases.some((phase) => names.includes(phase.phase) && statuses.some((status) => (phase.statuses.get(status) ?? 0) > 0));
}

function phaseDurationMs(phase: RunPhaseTiming, referenceAt: string): number {
  if (typeof phase.durationMs === "number" && Number.isFinite(phase.durationMs)) return Math.max(0, phase.durationMs);
  const started = Date.parse(phase.startedAt);
  const finished = Date.parse(phase.finishedAt ?? referenceAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function phaseStartedMs(phase: RunPhaseTiming): number {
  const started = Date.parse(phase.startedAt);
  return Number.isFinite(started) ? started : Number.POSITIVE_INFINITY;
}

function runTotalMs(summary: RunSummary, phases: RunPhaseTiming[], referenceAt: string, measuredMs: number): number {
  const started = Date.parse(summary.startedAt);
  const finishedCandidates = [summary.finishedAt, ...phases.map((phase) => phase.finishedAt ?? referenceAt)]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter(Number.isFinite);
  const finished = Math.max(...finishedCandidates);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return measuredMs;
  return Math.max(0, finished - started);
}

function phaseStatusSummary(phase: PhaseAggregate): string {
  const statuses = [...phase.statuses.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`);
  return [...statuses, phase.openCount > 0 ? `${phase.openCount} open` : null].filter((item): item is string => item !== null).join(", ");
}

function formatDuration(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
