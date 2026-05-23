import { createHash, randomBytes } from "node:crypto";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { formatRunCycleDiagnostics } from "./cycle-time.js";
import { ensureDir, exists, writeTextAtomicEnsuringDir, writeTextEnsuringDir } from "./fs-utils.js";
import { AGENT_OWNED_LIFECYCLE_EVIDENCE_ARTIFACT } from "./run-artifact-names.js";
import { boundEventForJsonl, parseAgentEventsFromJsonl, safeJsonStringify, summarizeText } from "./output-capture.js";
import { artifactNameFromReference, captureArtifactReferences } from "./run-capture-artifacts.js";
import { redactText, redactValue } from "./redaction.js";
import type { AgentOwnedLifecycleEvidence } from "./agentOwnedEvidenceTypes.js";
import type { AgentEvent, AgentRunResult, Issue, Workspace } from "./types.js";

export const RUN_SUMMARY_SCHEMA_VERSION = 1;
const HASHED_ARTIFACTS = ["prompt.md", "events.jsonl", "handoff.md", AGENT_OWNED_LIFECYCLE_EVIDENCE_ARTIFACT] as const;
export type RunArtifactName = (typeof HASHED_ARTIFACTS)[number];

// Measurement buckets for run timing. These are not orchestrator lifecycle
// states; write sites map lifecycle/review/merge events into these buckets.
export const RUN_TIMING_PHASES = [
  "implementation",
  "validation",
  "automated-review",
  "fixer-turn",
  "ci-wait",
  "merge-shepherding",
  "retry-backoff",
  "stall-cancel",
  "human-wait",
  "needs-input"
] as const;

export type RunTimingPhase = (typeof RUN_TIMING_PHASES)[number];
export type RunTimingStatus = "running" | "completed" | "failed" | "canceled" | "stalled" | "waiting";

export interface RunPhaseTiming {
  id: string;
  phase: RunTimingPhase;
  label?: string;
  status: RunTimingStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface RunPhaseStartResult {
  phase: RunPhaseTiming;
  created: boolean;
}

export interface RunTimingState {
  updatedAt: string;
  phases: RunPhaseTiming[];
}

export interface RunSummary {
  schemaVersion: 1;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  status: "running" | AgentRunResult["status"];
  startedAt: string;
  lastEventAt?: string;
  finishedAt?: string;
  workspacePath?: string;
  stopReason?: string;
  error?: string;
  metrics: {
    tokens: {
      input?: number;
      output?: number;
      total?: number;
    };
    sessions: {
      threadId?: string;
      turnId?: string;
    };
    rateLimits: Array<Record<string, unknown>>; modelRouting: import("./types.js").ModelTelemetryEntry[];
  };
  timing?: RunTimingState;
  artifactHashes: Record<string, string>;
}

export class RunArtifactStore {
  private summaryQueues = new Map<string, Promise<void>>();

  constructor(private readonly repoRoot: string) {}

  async startRun(input: { issue: Issue; attempt: number | null; workspace?: Workspace }): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const runId = createRunId(input.issue.identifier, startedAt);
    const summary: RunSummary = {
      schemaVersion: RUN_SUMMARY_SCHEMA_VERSION,
      runId,
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      attempt: input.attempt,
      status: "running",
      startedAt,
      lastEventAt: startedAt,
      workspacePath: input.workspace?.path,
      metrics: {
        tokens: {},
        sessions: {},
        rateLimits: [], modelRouting: []
      },
      artifactHashes: {}
    };
    await ensureDir(this.runDir(runId));
    await this.writeSummary(summary);
    return summary;
  }

  async writePrompt(runId: string, prompt: string): Promise<void> {
    await writeTextEnsuringDir(this.pathFor(runId, "prompt.md"), redactText(prompt));
  }

  async setWorkspace(runId: string, workspace: Workspace): Promise<void> { await this.updateSummary(runId, (current) => ({ ...current, workspacePath: workspace.path })); }

  async writeHandoff(runId: string, handoff: string): Promise<void> { await writeTextEnsuringDir(this.pathFor(runId, "handoff.md"), redactText(handoff)); }

  async writeAgentOwnedLifecycleEvidence(runId: string, evidence: AgentOwnedLifecycleEvidence): Promise<void> { await writeTextEnsuringDir(this.pathFor(runId, AGENT_OWNED_LIFECYCLE_EVIDENCE_ARTIFACT), `${JSON.stringify(redactValue(evidence), null, 2)}\n`); await this.refreshArtifactHashes(runId, [AGENT_OWNED_LIFECYCLE_EVIDENCE_ARTIFACT]); }

  async writeEvent(runId: string, event: AgentEvent & { runId?: string }): Promise<void> {
    await ensureDir(this.runDir(runId));
    const bounded = await boundEventForJsonl({ ...event, runId }, { repoRoot: this.repoRoot, runId });
    await appendFile(this.pathFor(runId, "events.jsonl"), `${safeJsonStringify(bounded)}\n`, "utf8");
    await this.touchEvent(runId, event.timestamp);
  }

  async startPhase(
    runId: string,
    input: {
      phase: RunTimingPhase;
      label?: string;
      startedAt?: string;
      status?: Extract<RunTimingStatus, "running" | "waiting">;
      metadata?: Record<string, unknown>;
    }
  ): Promise<RunPhaseTiming> {
    let entry!: RunPhaseTiming;
    const startedAt = input.startedAt ?? new Date().toISOString();
    await this.updateSummary(runId, (current) => {
      const phases = current.timing?.phases ?? [];
      entry = compactPhaseTiming({
        id: `${input.phase}-${phases.length + 1}`,
        phase: input.phase,
        label: input.label,
        status: input.status ?? "running",
        startedAt,
        metadata: input.metadata
      });
      return withTiming(current, [...phases, entry], startedAt);
    });
    return entry;
  }

  async startOrUpdateOpenPhase(
    runId: string,
    input: {
      phase: RunTimingPhase;
      label?: string;
      startedAt?: string;
      status?: Extract<RunTimingStatus, "running" | "waiting">;
      metadata?: Record<string, unknown>;
    }
  ): Promise<RunPhaseStartResult> {
    let phase!: RunPhaseTiming;
    let created = false;
    const startedAt = input.startedAt ?? new Date().toISOString();
    await this.updateSummary(runId, (current) => {
      const phases = current.timing?.phases ?? [];
      const index = findOpenPhaseIndex(phases, { phase: input.phase });
      if (index !== -1) {
        const next = [...phases];
        phase = compactPhaseTiming({
          ...next[index],
          label: input.label ?? next[index].label,
          status: input.status ?? next[index].status,
          metadata: {
            ...(next[index].metadata ?? {}),
            ...(input.metadata ?? {})
          }
        });
        next[index] = phase;
        return withTiming(current, next, startedAt);
      }

      created = true;
      phase = compactPhaseTiming({
        id: `${input.phase}-${phases.length + 1}`,
        phase: input.phase,
        label: input.label,
        status: input.status ?? "running",
        startedAt,
        metadata: input.metadata
      });
      return withTiming(current, [...phases, phase], startedAt);
    });
    return { phase, created };
  }

  async finishPhase(
    runId: string,
    match: { id?: string; phase?: RunTimingPhase },
    input: {
      finishedAt?: string;
      status?: Exclude<RunTimingStatus, "running">;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<RunPhaseTiming | null> {
    let entry: RunPhaseTiming | null = null;
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    await this.updateSummary(runId, (current) => {
      const phases = current.timing?.phases ?? [];
      const index = findOpenPhaseIndex(phases, match);
      if (index === -1) return current;
      const next = [...phases];
      entry = finishPhaseTiming(next[index], finishedAt, input.status ?? "completed", input.metadata);
      next[index] = entry;
      return withTiming(current, next, finishedAt);
    });
    return entry;
  }

  async finishOpenPhases(
    runId: string,
    match: { id?: string; phase?: RunTimingPhase },
    input: {
      finishedAt?: string;
      status?: Exclude<RunTimingStatus, "running">;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<RunPhaseTiming[]> {
    let entries: RunPhaseTiming[] = [];
    const finishedAt = input.finishedAt ?? new Date().toISOString();
    await this.updateSummary(runId, (current) => {
      const phases = current.timing?.phases ?? [];
      const next = phases.map((phase) => {
        if (!isOpenPhaseMatch(phase, match)) return phase;
        const finished = finishPhaseTiming(phase, finishedAt, input.status ?? "completed", input.metadata);
        entries = [...entries, finished];
        return finished;
      });
      return entries.length === 0 ? current : withTiming(current, next, finishedAt);
    });
    return entries;
  }

  async completeRun(runId: string, result: AgentRunResult): Promise<RunSummary> {
    const finishedAt = new Date().toISOString();
    let syntheticPhase: RunPhaseTiming | null = null;
    let finalizedPhases: RunPhaseTiming[] = [];
    const completed = await this.updateSummary(runId, async (current) => {
      const finalizedTiming = finalizeRunTiming(current, result, finishedAt);
      syntheticPhase = finalizedTiming.syntheticPhase;
      finalizedPhases = finalizedTiming.finalizedPhases;
      return {
        ...current,
        status: result.status,
        finishedAt,
        stopReason: summarizeOptional(result.error ?? (result.status === "succeeded" ? undefined : result.status)),
        error: summarizeOptional(result.error),
        metrics: {
          tokens: {
            input: result.inputTokens,
            output: result.outputTokens,
            total: result.totalTokens
          },
          sessions: {
            threadId: result.threadId,
            turnId: result.turnId
          },
          rateLimits: result.rateLimits ?? current.metrics.rateLimits,
          modelRouting: result.modelTelemetry ? [...(current.metrics.modelRouting ?? []), result.modelTelemetry] : (current.metrics.modelRouting ?? [])
        },
        timing: finalizedTiming.timing,
        artifactHashes: await this.hashArtifacts(runId)
      };
    });
    if (finalizedPhases.length === 0 && !syntheticPhase) return completed;
    for (const phase of finalizedPhases) {
      await this.writePhaseFinishedEvent(runId, completed, phase);
    }
    if (syntheticPhase) await this.writePhaseTimingEvents(runId, completed, syntheticPhase);
    return this.refreshArtifactHashes(runId);
  }

  async failRun(runId: string, error: string): Promise<RunSummary> {
    return this.completeRun(runId, { status: "failed", error });
  }

  async markRunStale(runId: string, reason: string): Promise<RunSummary> {
    return this.completeRun(runId, { status: "stale", error: reason });
  }

  async markRunCanceled(runId: string, reason: string): Promise<RunSummary> {
    return this.completeRun(runId, { status: "canceled", error: reason });
  }

  async inspect(runId: string): Promise<{ summary: RunSummary; warnings: string[] }> {
    await this.summaryQueues.get(runId);
    const summary = await this.readSummary(runId);
    const actualHashes = await this.hashArtifacts(runId);
    const referencedArtifacts = await this.referencedCaptureArtifacts(runId);
    const warnings = Object.entries(summary.artifactHashes)
      .filter(([name, hash]) => actualHashes[name] !== hash)
      .map(([name]) => `artifact hash mismatch: ${name}`);
    for (const name of referencedArtifacts) {
      if (!summary.artifactHashes[name] && !(await this.isFileArtifact(runId, name))) {
        warnings.push(`artifact missing: ${name}`);
      }
    }
    return { summary, warnings };
  }

  async listRuns(): Promise<RunSummary[]> {
    const root = join(this.repoRoot, ".agent-os", "runs");
    if (!(await exists(root))) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const summaries: RunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summaryPath = join(root, entry.name, "summary.json");
      if (await exists(summaryPath)) summaries.push(JSON.parse(await readFile(summaryPath, "utf8")) as RunSummary);
    }
    return summaries.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async replay(runId: string): Promise<AgentEvent[]> {
    const path = this.pathFor(runId, "events.jsonl");
    if (!(await exists(path))) return [];
    return parseAgentEventsFromJsonl(await readFile(path, "utf8"));
  }

  async refreshArtifactHashes(runId: string, artifactNames?: RunArtifactName[]): Promise<RunSummary> {
    await this.summaryQueues.get(runId);
    const names = artifactNames ? [...new Set(artifactNames)] : null;
    return this.updateSummary(runId, async (current) => {
      if (!names) {
        return {
          ...current,
          artifactHashes: await this.hashArtifacts(runId)
        };
      }
      const selected = await this.hashArtifacts(runId, names);
      const artifactHashes = { ...current.artifactHashes };
      for (const name of names) {
        if (selected[name]) artifactHashes[name] = selected[name];
        else delete artifactHashes[name];
      }
      return { ...current, artifactHashes };
    });
  }

  async simulateRun(input: { issueIdentifier: string; status?: AgentRunResult["status"] }): Promise<RunSummary> {
    const issue: Issue = {
      id: `simulation-${input.issueIdentifier}`,
      identifier: input.issueIdentifier,
      title: `Simulated run for ${input.issueIdentifier}`,
      description: null,
      priority: null,
      state: "Simulation",
      branch_name: null,
      url: null,
      labels: ["simulation"],
      blocked_by: [],
      created_at: null,
      updated_at: null
    };
    const summary = await this.startRun({
      issue,
      attempt: null,
      workspace: { path: join(this.repoRoot, ".agent-os", "simulation", input.issueIdentifier), workspaceKey: input.issueIdentifier, createdNow: true }
    });
    await this.writePrompt(summary.runId, "AgentOS simulation run. No Linear, GitHub, or Codex calls are made.");
    await this.writeEvent(summary.runId, {
      type: "simulation_started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: "local simulation",
      timestamp: new Date().toISOString()
    });
    await this.writeHandoff(summary.runId, "AgentOS-Outcome: already-satisfied\n\nSimulation: local artifact-only run.");
    await this.writeEvent(summary.runId, {
      type: `run_${input.status ?? "succeeded"}`,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: "simulation complete",
      timestamp: new Date().toISOString()
    });
    return this.completeRun(summary.runId, { status: input.status ?? "succeeded" });
  }

  private async readSummary(runId: string): Promise<RunSummary> {
    return JSON.parse(await readFile(this.pathFor(runId, "summary.json"), "utf8")) as RunSummary;
  }

  private async touchEvent(runId: string, timestamp: string): Promise<void> {
    const path = this.pathFor(runId, "summary.json");
    if (!(await exists(path))) return;
    await this.updateSummary(runId, (current) => (current.status === "running" ? { ...current, lastEventAt: timestamp } : current));
  }

  private async writeSummary(summary: RunSummary): Promise<void> {
    await writeTextAtomicEnsuringDir(this.pathFor(summary.runId, "summary.json"), `${JSON.stringify(redactValue(summary), null, 2)}\n`);
  }

  private async updateSummary(runId: string, mutator: (current: RunSummary) => RunSummary | Promise<RunSummary>): Promise<RunSummary> {
    const previous = this.summaryQueues.get(runId) ?? Promise.resolve();
    let nextSummary!: RunSummary;
    const next = previous.then(async () => {
      const current = await this.readSummary(runId);
      nextSummary = await mutator(current);
      await this.writeSummary(nextSummary);
    });
    this.summaryQueues.set(
      runId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    await next;
    return nextSummary;
  }

  private async hashArtifacts(runId: string, artifactNames?: readonly string[]): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    const names = new Set<string>(artifactNames ?? HASHED_ARTIFACTS);
    if (!artifactNames || artifactNames.includes("events.jsonl")) {
      for (const name of await this.referencedCaptureArtifacts(runId)) names.add(name);
    }
    for (const name of names) {
      const path = this.pathFor(runId, name);
      if (!(await this.isFilePath(path))) continue;
      hashes[name] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    return hashes;
  }

  private async referencedCaptureArtifacts(runId: string): Promise<string[]> {
    const path = this.pathFor(runId, "events.jsonl");
    if (!(await exists(path))) return [];
    const references = captureArtifactReferences(await readFile(path, "utf8"));
    const names = new Set<string>();
    for (const reference of references) {
      const name = artifactNameFromReference(runId, reference);
      if (name) names.add(name);
    }
    return [...names].sort();
  }

  private async isFileArtifact(runId: string, name: string): Promise<boolean> {
    return this.isFilePath(this.pathFor(runId, name));
  }

  private async isFilePath(path: string): Promise<boolean> {
    if (!(await exists(path))) return false;
    return (await stat(path)).isFile();
  }

  private runDir(runId: string): string {
    return join(this.repoRoot, ".agent-os", "runs", runId);
  }

  private pathFor(runId: string, name: string): string {
    return join(this.runDir(runId), name);
  }

  private async writePhaseTimingEvents(runId: string, summary: RunSummary, phase: RunPhaseTiming): Promise<void> {
    const started = compactPhaseTiming({
      id: phase.id,
      phase: phase.phase,
      label: phase.label,
      status: "running",
      startedAt: phase.startedAt,
      metadata: phase.metadata
    });
    await this.writeEvent(runId, {
      type: "phase_started",
      issueId: summary.issueId,
      issueIdentifier: summary.issueIdentifier,
      message: started.label ?? started.phase,
      timestamp: started.startedAt,
      payload: { timing: started }
    });
    await this.writePhaseFinishedEvent(runId, summary, phase);
  }

  private async writePhaseFinishedEvent(runId: string, summary: RunSummary, phase: RunPhaseTiming): Promise<void> {
    await this.writeEvent(runId, {
      type: "phase_finished",
      issueId: summary.issueId,
      issueIdentifier: summary.issueIdentifier,
      message: phase.label ?? phase.phase,
      timestamp: phase.finishedAt ?? phase.startedAt,
      payload: { timing: phase }
    });
  }
}

function withTiming(summary: RunSummary, phases: RunPhaseTiming[], updatedAt: string): RunSummary {
  return {
    ...summary,
    timing: {
      updatedAt,
      phases
    }
  };
}

function findOpenPhaseIndex(phases: RunPhaseTiming[], match: { id?: string; phase?: RunTimingPhase }): number {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (isOpenPhaseMatch(phase, match)) return index;
  }
  return -1;
}

function isOpenPhaseMatch(phase: RunPhaseTiming, match: { id?: string; phase?: RunTimingPhase }): boolean {
  if (phase.finishedAt) return false;
  if (match.id && phase.id !== match.id) return false;
  if (match.phase && phase.phase !== match.phase) return false;
  return true;
}

function finishPhaseTiming(
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

function finalizeRunTiming(
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

function compactPhaseTiming<T extends RunPhaseTiming>(entry: T): T {
  const next = { ...entry };
  if (!next.label) delete next.label;
  if (next.durationMs == null) delete next.durationMs;
  if (!next.metadata || Object.keys(next.metadata).length === 0) delete next.metadata;
  return next;
}

export function formatRunInspect(result: { summary: RunSummary; warnings: string[] }, options: { now?: string } = {}): string {
  const { summary, warnings } = result;
  const lines = [
    `Run: ${summary.runId}`,
    `Issue: ${summary.issueIdentifier}`,
    `Status: ${summary.status}`,
    `Started: ${summary.startedAt}`,
    summary.finishedAt ? `Finished: ${summary.finishedAt}` : null,
    summary.metrics.sessions.threadId ? `Thread: ${summary.metrics.sessions.threadId}` : null,
    summary.metrics.sessions.turnId ? `Turn: ${summary.metrics.sessions.turnId}` : null,
    tokenLine(summary),
    rateLimitLine(summary), modelRoutingLine(summary),
    formatRunCycleDiagnostics(summary, options),
    summary.error ? `Error: ${summary.error}` : null,
    warnings.length ? `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "Warnings: none"
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function formatRunReplay(runId: string, events: AgentEvent[]): string {
  if (events.length === 0) return `Run: ${runId}\nReplay: no events recorded`;
  return [`Run: ${runId}`, "Replay:", ...events.map((event) => `${event.timestamp} ${event.type}${event.message ? ` - ${event.message}` : ""}`)].join("\n");
}

function tokenLine(summary: RunSummary): string {
  const tokens = summary.metrics.tokens;
  if (tokens.input == null && tokens.output == null && tokens.total == null) return "Tokens: none recorded";
  return `Tokens: input=${tokens.input ?? "unknown"} output=${tokens.output ?? "unknown"} total=${tokens.total ?? "unknown"}`;
}

function rateLimitLine(summary: RunSummary): string {
  const count = summary.metrics.rateLimits.length;
  return count > 0 ? `Rate limits: ${count} snapshot${count === 1 ? "" : "s"} recorded` : "Rate limits: none recorded";
}

function modelRoutingLine(summary: RunSummary): string { const routes = summary.metrics.modelRouting ?? []; return routes.length === 0 ? "Model routing: none recorded" : `Model routing: ${routes.map((route) => `${route.role}=${route.applied ? route.model : route.proposedModel ? `${route.mode}:${route.proposedModel}` : route.model}${route.escalationReason ? ` promoted(${route.escalationReason})` : ""}; ${route.elapsedMs}ms; tokens=${route.tokenUsage.total ?? "unknown"}; cost=${route.costBucket}`).join(" | ")}`; }
function summarizeOptional(value: string | undefined): string | undefined {
  return value ? summarizeText(value).inline : undefined;
}
function createRunId(identifier: string, timestamp: string): string {
  const stamp = timestamp.replace(/[-:.TZ]/g, "").slice(0, 14);
  const safeIdentifier = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return `run_${stamp}_${safeIdentifier}_${randomBytes(3).toString("hex")}`;
}
