import { createHash, randomBytes } from "node:crypto";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, exists, writeTextEnsuringDir } from "./fs-utils.js";
import { redactText, redactValue } from "./redaction.js";
import type { AgentEvent, AgentRunResult, Issue, Workspace } from "./types.js";

export const RUN_SUMMARY_SCHEMA_VERSION = 1;

export interface RunSummary {
  schemaVersion: 1;
  runId: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  status: "running" | AgentRunResult["status"];
  startedAt: string;
  finishedAt?: string;
  workspacePath?: string;
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
    rateLimits: Array<Record<string, unknown>>;
  };
  artifactHashes: Record<string, string>;
}

export class RunArtifactStore {
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
      workspacePath: input.workspace?.path,
      metrics: {
        tokens: {},
        sessions: {},
        rateLimits: []
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

  async setWorkspace(runId: string, workspace: Workspace): Promise<void> {
    const current = await this.readSummary(runId);
    await this.writeSummary({ ...current, workspacePath: workspace.path });
  }

  async writeHandoff(runId: string, handoff: string): Promise<void> {
    await writeTextEnsuringDir(this.pathFor(runId, "handoff.md"), redactText(handoff));
  }

  async writeEvent(runId: string, event: AgentEvent & { runId?: string }): Promise<void> {
    await ensureDir(this.runDir(runId));
    await appendFile(this.pathFor(runId, "events.jsonl"), `${JSON.stringify(redactValue({ ...event, runId }))}\n`, "utf8");
  }

  async completeRun(runId: string, result: AgentRunResult): Promise<RunSummary> {
    const current = await this.readSummary(runId);
    const summary: RunSummary = {
      ...current,
      status: result.status,
      finishedAt: new Date().toISOString(),
      error: result.error,
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
        rateLimits: current.metrics.rateLimits
      },
      artifactHashes: await this.hashArtifacts(runId)
    };
    await this.writeSummary(summary);
    return summary;
  }

  async failRun(runId: string, error: string): Promise<RunSummary> {
    return this.completeRun(runId, { status: "failed", error });
  }

  async inspect(runId: string): Promise<{ summary: RunSummary; warnings: string[] }> {
    const summary = await this.readSummary(runId);
    const actualHashes = await this.hashArtifacts(runId);
    const warnings = Object.entries(summary.artifactHashes)
      .filter(([name, hash]) => actualHashes[name] !== hash)
      .map(([name]) => `artifact hash mismatch: ${name}`);
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

  private async readSummary(runId: string): Promise<RunSummary> {
    return JSON.parse(await readFile(this.pathFor(runId, "summary.json"), "utf8")) as RunSummary;
  }

  private async writeSummary(summary: RunSummary): Promise<void> {
    await writeTextEnsuringDir(this.pathFor(summary.runId, "summary.json"), `${JSON.stringify(redactValue(summary), null, 2)}\n`);
  }

  private async hashArtifacts(runId: string): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const name of ["prompt.md", "events.jsonl", "handoff.md"]) {
      const path = this.pathFor(runId, name);
      if (!(await exists(path))) continue;
      if (!(await stat(path)).isFile()) continue;
      hashes[name] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
    return hashes;
  }

  private runDir(runId: string): string {
    return join(this.repoRoot, ".agent-os", "runs", runId);
  }

  private pathFor(runId: string, name: string): string {
    return join(this.runDir(runId), name);
  }
}

export function formatRunInspect(result: { summary: RunSummary; warnings: string[] }): string {
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
    summary.error ? `Error: ${summary.error}` : null,
    warnings.length ? `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "Warnings: none"
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function tokenLine(summary: RunSummary): string {
  const tokens = summary.metrics.tokens;
  if (tokens.input == null && tokens.output == null && tokens.total == null) return "Tokens: none recorded";
  return `Tokens: input=${tokens.input ?? "unknown"} output=${tokens.output ?? "unknown"} total=${tokens.total ?? "unknown"}`;
}

function createRunId(identifier: string, timestamp: string): string {
  const stamp = timestamp.replace(/[-:.TZ]/g, "").slice(0, 14);
  const safeIdentifier = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return `run_${stamp}_${safeIdentifier}_${randomBytes(3).toString("hex")}`;
}
