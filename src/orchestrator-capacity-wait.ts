import type { PhaseTimingEventInput } from "./phase-timing.js";
import type { RetryEntry } from "./orchestrator-retry.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import type { Issue, Workspace } from "./types.js";

export async function scheduleCapacityWait(input: {
  issue: Issue;
  previousAttempt: number | null;
  error: string | null;
  resetAt: string;
  runId?: string;
  workspace?: Workspace;
  retries: Map<string, RetryEntry>;
  runtimeState: RuntimeStateStore;
  maxAttempts: number;
  writePhaseTimingEvent: (issue: Issue, event: PhaseTimingEventInput) => Promise<void>;
}): Promise<RetryEntry> {
  const scheduledAt = new Date().toISOString();
  const dueAtMs = Math.max(Date.now(), Date.parse(input.resetAt));
  const attempt = input.previousAttempt ?? 0;
  const retry = {
    issueId: input.issue.id,
    identifier: input.issue.identifier,
    issue: input.issue,
    attempt,
    dueAtMs,
    scheduledAt,
    error: input.error,
    runId: input.runId
  };
  const dueAt = new Date(retry.dueAtMs).toISOString();
  input.retries.set(input.issue.id, retry);
  await input.runtimeState.upsertRetry({
    issueId: input.issue.id,
    identifier: input.issue.identifier,
    issue: input.issue,
    attempt,
    dueAt,
    error: input.error,
    errorCategory: "capacity-wait",
    scheduledAt,
    runId: input.runId,
    workspacePath: input.workspace?.path,
    workspaceKey: input.workspace?.workspaceKey
  });
  await input.writePhaseTimingEvent(input.issue, {
    phase: "retry-backoff",
    status: "waiting",
    runId: input.runId,
    startedAt: scheduledAt,
    label: "capacity wait scheduled",
    metadata: {
      attempt,
      maxAttempts: input.maxAttempts,
      delayMs: Math.max(0, retry.dueAtMs - Date.now()),
      dueAt,
      errorCategory: "capacity-wait",
      runId: input.runId
    }
  });
  return retry;
}
