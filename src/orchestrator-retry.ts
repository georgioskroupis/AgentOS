import { categorizeRunError } from "./run-errors.js";
import type { RuntimeRetryEntry, RuntimeStateStore } from "./runtime-state.js";
import type { Issue } from "./types.js";

export interface RetryEntry {
  issueId: string;
  identifier: string;
  issue: Issue;
  attempt: number;
  dueAtMs: number;
  scheduledAt?: string;
  error: string | null;
  runId?: string;
}

export function runtimeRetryToMemory(retry: RuntimeRetryEntry): RetryEntry {
  const due = Date.parse(retry.dueAt);
  return {
    issueId: retry.issueId,
    identifier: retry.identifier,
    issue: retry.issue,
    attempt: retry.attempt,
    dueAtMs: Number.isFinite(due) ? due : Date.now(),
    scheduledAt: retry.scheduledAt,
    error: retry.error,
    runId: retry.runId
  };
}

export async function readRuntimeRetryForIssue(runtimeState: RuntimeStateStore, issue: Issue): Promise<RetryEntry | null> {
  const runtime = await runtimeState.read().catch(() => null);
  const retry = runtime?.retryQueue.find((entry) => entry.issueId === issue.id || entry.identifier === issue.identifier);
  return retry ? runtimeRetryToMemory(retry) : null;
}

export function retryBackoffFinishMetadata(retry: RetryEntry, reason: string): Record<string, unknown> {
  return {
    attempt: retry.attempt,
    dueAt: new Date(retry.dueAtMs).toISOString(),
    reason,
    ...(retry.scheduledAt ? { scheduledAt: retry.scheduledAt } : {}),
    ...(retry.error ? { errorCategory: categorizeRunError(retry.error) } : {})
  };
}
