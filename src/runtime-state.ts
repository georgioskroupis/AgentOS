import { join } from "node:path";
import { exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import type { Issue, RunErrorCategory, RunPhase } from "./types.js";

export const RUNTIME_STATE_SCHEMA_VERSION = 1;

export interface RuntimeDaemonState {
  startedAt: string;
  startGitSha?: string | null;
  startMainGitSha?: string | null;
  currentGitSha?: string | null;
  currentMainGitSha?: string | null;
  workflowPath: string;
  freshnessStatus?: "fresh" | "main_advanced";
  freshnessMessage?: string | null;
}

export interface RuntimeActiveRun {
  issueId: string;
  identifier: string;
  issue: Issue;
  attempt: number | null;
  runId?: string;
  startedAt: string;
  lastEventAt?: string;
  stopReason?: string | null;
  phase?: RunPhase;
  workspacePath?: string;
  workspaceKey?: string;
}

export interface RuntimeRetryEntry {
  issueId: string;
  identifier: string;
  issue: Issue;
  attempt: number;
  dueAt: string;
  error: string | null;
  errorCategory?: RunErrorCategory;
  scheduledAt: string;
  runId?: string;
  workspacePath?: string;
  workspaceKey?: string;
}

export interface RuntimeClaimedIssue {
  issueId: string;
  identifier: string;
  issue: Issue;
  claimedAt: string;
  runId?: string;
  workspacePath?: string;
  workspaceKey?: string;
}

export interface RuntimeRecoverySummary {
  recoveredAt: string;
  messages: string[];
  staleRuns: number;
  retriesRebuilt: number;
  terminalIssues: number;
  locksReleased: number;
  freshnessWarnings: number;
}

export interface RuntimeState {
  schemaVersion: 1;
  updatedAt: string;
  daemon?: RuntimeDaemonState;
  activeRuns: RuntimeActiveRun[];
  retryQueue: RuntimeRetryEntry[];
  claimedIssues: RuntimeClaimedIssue[];
  lastRecovery?: RuntimeRecoverySummary;
}

export class RuntimeStateStore {
  constructor(private readonly repoRoot: string) {}

  async read(): Promise<RuntimeState> {
    const path = this.path();
    if (!(await exists(path))) return emptyRuntimeState();
    const parsed = JSON.parse(await readText(path)) as Partial<RuntimeState>;
    return normalizeRuntimeState(parsed);
  }

  async write(state: RuntimeState): Promise<void> {
    await writeTextEnsuringDir(this.path(), `${JSON.stringify(normalizeRuntimeState(state), null, 2)}\n`);
  }

  async update(mutator: (state: RuntimeState) => void): Promise<RuntimeState> {
    const state = await this.read();
    mutator(state);
    state.updatedAt = new Date().toISOString();
    const normalized = normalizeRuntimeState(state);
    await this.write(normalized);
    return normalized;
  }

  async setDaemon(daemon: RuntimeDaemonState): Promise<RuntimeState> {
    return this.update((state) => {
      state.daemon = daemon;
    });
  }

  async upsertActiveRun(entry: RuntimeActiveRun): Promise<RuntimeState> {
    return this.update((state) => {
      state.activeRuns = upsertByIssueId(state.activeRuns, entry);
      state.claimedIssues = upsertByIssueId(state.claimedIssues, {
        issueId: entry.issueId,
        identifier: entry.identifier,
        issue: entry.issue,
        claimedAt: entry.startedAt,
        runId: entry.runId,
        workspacePath: entry.workspacePath,
        workspaceKey: entry.workspaceKey
      });
    });
  }

  async patchActiveRun(issueId: string, patch: Partial<RuntimeActiveRun>): Promise<RuntimeState> {
    return this.update((state) => {
      state.activeRuns = state.activeRuns.map((entry) => (entry.issueId === issueId ? { ...entry, ...patch } : entry));
      state.claimedIssues = state.claimedIssues.map((entry) => (entry.issueId === issueId ? { ...entry, ...claimPatch(patch) } : entry));
    });
  }

  async removeActiveRun(issueId: string): Promise<RuntimeState> {
    return this.update((state) => {
      state.activeRuns = state.activeRuns.filter((entry) => entry.issueId !== issueId);
      state.claimedIssues = state.claimedIssues.filter((entry) => entry.issueId !== issueId);
    });
  }

  async upsertClaim(entry: RuntimeClaimedIssue): Promise<RuntimeState> {
    return this.update((state) => {
      state.claimedIssues = upsertByIssueId(state.claimedIssues, entry);
    });
  }

  async removeClaim(issueId: string): Promise<RuntimeState> {
    return this.update((state) => {
      state.claimedIssues = state.claimedIssues.filter((entry) => entry.issueId !== issueId);
    });
  }

  async upsertRetry(entry: RuntimeRetryEntry): Promise<RuntimeState> {
    return this.update((state) => {
      state.retryQueue = upsertByIssueId(state.retryQueue, entry).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    });
  }

  async removeRetry(issueId: string): Promise<RuntimeState> {
    return this.update((state) => {
      state.retryQueue = state.retryQueue.filter((entry) => entry.issueId !== issueId);
    });
  }

  async clearIssue(issueId: string): Promise<RuntimeState> {
    return this.update((state) => {
      state.activeRuns = state.activeRuns.filter((entry) => entry.issueId !== issueId);
      state.claimedIssues = state.claimedIssues.filter((entry) => entry.issueId !== issueId);
      state.retryQueue = state.retryQueue.filter((entry) => entry.issueId !== issueId);
    });
  }

  async recordRecovery(summary: RuntimeRecoverySummary): Promise<RuntimeState> {
    return this.update((state) => {
      state.lastRecovery = summary;
    });
  }

  private path(): string {
    return join(this.repoRoot, ".agent-os", "state", "runtime.json");
  }
}

function emptyRuntimeState(): RuntimeState {
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    activeRuns: [],
    retryQueue: [],
    claimedIssues: []
  };
}

function normalizeRuntimeState(raw: Partial<RuntimeState>): RuntimeState {
  const fallback = emptyRuntimeState();
  return {
    schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : fallback.updatedAt,
    ...(raw.daemon ? { daemon: raw.daemon } : {}),
    activeRuns: Array.isArray(raw.activeRuns) ? raw.activeRuns.filter(hasIssueIdentity) : [],
    retryQueue: Array.isArray(raw.retryQueue) ? raw.retryQueue.filter(hasRetryIdentity).sort((a, b) => a.dueAt.localeCompare(b.dueAt)) : [],
    claimedIssues: Array.isArray(raw.claimedIssues) ? raw.claimedIssues.filter(hasIssueIdentity) : [],
    ...(raw.lastRecovery ? { lastRecovery: raw.lastRecovery } : {})
  };
}

function hasIssueIdentity<T extends { issueId?: string; identifier?: string }>(entry: T): entry is T & { issueId: string; identifier: string } {
  return Boolean(entry.issueId && entry.identifier);
}

function hasRetryIdentity(entry: RuntimeRetryEntry): entry is RuntimeRetryEntry {
  return hasIssueIdentity(entry) && typeof entry.dueAt === "string" && typeof entry.attempt === "number";
}

function upsertByIssueId<T extends { issueId: string }>(entries: T[], entry: T): T[] {
  const without = entries.filter((item) => item.issueId !== entry.issueId);
  return [...without, entry];
}

function claimPatch(patch: Partial<RuntimeActiveRun>): Partial<RuntimeClaimedIssue> {
  return {
    ...(patch.issue ? { issue: patch.issue } : {}),
    ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
    ...(patch.workspacePath !== undefined ? { workspacePath: patch.workspacePath } : {}),
    ...(patch.workspaceKey !== undefined ? { workspaceKey: patch.workspaceKey } : {})
  };
}
