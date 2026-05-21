import { join } from "node:path";
import { workspaceBootstrapFailedCommentBody } from "./orchestrator-lifecycle-comments.js";
import { displayAttempt } from "./orchestrator-state-helpers.js";
import { summarizeText } from "./output-capture.js";
import type { PhaseTimingEventInput } from "./phase-timing.js";
import type { RunArtifactStore } from "./runs.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import { workspaceKey, type WorkspaceManager } from "./workspace.js";
import type { AgentEvent, Issue, IssueState, ServiceConfig, Workspace } from "./types.js";

export function plannedWorkspaceForIssue(config: ServiceConfig, issueIdentifier: string): Workspace {
  const key = workspaceKey(issueIdentifier);
  return {
    path: join(config.workspace.root, key),
    workspaceKey: key,
    createdNow: false
  };
}

export async function handleWorkspaceBootstrapFailure(input: {
  issue: Issue;
  workspace: Workspace;
  attempt: number | null;
  error: Error;
  runId: string;
  config: ServiceConfig;
  runtimeState: RuntimeStateStore;
  runArtifacts: RunArtifactStore;
  writeRunEvent: (runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }) => Promise<void>;
  recordIssueState: (issue: Issue, patch: Partial<IssueState>) => Promise<IssueState>;
  commentIssue: (issue: Issue, body: string, key?: string) => Promise<void>;
  moveIssue: (issue: Issue, stateName: string | null) => Promise<unknown>;
  writePhaseTimingEvent: (issue: Issue, event: PhaseTimingEventInput) => Promise<void>;
}): Promise<void> {
  const safeError = summarizeText(input.error.message).inline;
  await input.writeRunEvent(input.runId, {
    type: "workspace_bootstrap_failed",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: safeError,
    payload: {
      hookCommand: input.config.hooks.afterCreate,
      workspacePath: input.workspace.path,
      workspaceKey: input.workspace.workspaceKey,
      errorCategory: "workspace"
    }
  });
  await input.recordIssueState(input.issue, {
    phase: "needs-input",
    lastRunId: input.runId,
    activeRunId: undefined,
    lastError: safeError,
    errorCategory: "workspace",
    lifecycleStatus: "implementation_failure",
    stopReason: `workspace_bootstrap_failed: ${safeError}`,
    workspacePath: input.workspace.path,
    workspaceKey: input.workspace.workspaceKey,
    nextRetryAt: undefined,
    retryAttempt: undefined
  });
  await input.runtimeState.clearIssue(input.issue.id, input.issue.identifier);
  await markLinearWorkspaceBootstrapFailed(input, safeError);
  await input.runArtifacts.failRun(input.runId, safeError);
}

export async function createWorkspaceForRun(input: {
  issue: Issue;
  attempt: number | null;
  runId: string;
  config: ServiceConfig;
  runtimeState: RuntimeStateStore;
  runArtifacts: RunArtifactStore;
  workspaceManager: WorkspaceManager;
  writeRunEvent: (runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }) => Promise<void>;
  recordIssueState: (issue: Issue, patch: Partial<IssueState>) => Promise<IssueState>;
  commentIssue: (issue: Issue, body: string, key?: string) => Promise<void>;
  moveIssue: (issue: Issue, stateName: string | null) => Promise<unknown>;
  writePhaseTimingEvent: (issue: Issue, event: PhaseTimingEventInput) => Promise<void>;
}): Promise<Workspace | null> {
  const plannedWorkspace = plannedWorkspaceForIssue(input.config, input.issue.identifier);
  await input.runtimeState.patchActiveRun(input.issue.id, {
    workspacePath: plannedWorkspace.path,
    workspaceKey: plannedWorkspace.workspaceKey
  });
  await input.recordIssueState(input.issue, {
    workspacePath: plannedWorkspace.path,
    workspaceKey: plannedWorkspace.workspaceKey
  });
  await input.runArtifacts.setWorkspace(input.runId, plannedWorkspace);
  const workspace = await input.workspaceManager.createOrReuse(input.issue.identifier).catch(async (error: Error) => {
    await handleWorkspaceBootstrapFailure({ ...input, workspace: plannedWorkspace, error });
    return null;
  });
  if (!workspace) return null;
  await input.runtimeState.patchActiveRun(input.issue.id, {
    workspacePath: workspace.path,
    workspaceKey: workspace.workspaceKey
  });
  await input.recordIssueState(input.issue, {
    workspacePath: workspace.path,
    workspaceKey: workspace.workspaceKey
  });
  await input.runArtifacts.setWorkspace(input.runId, workspace);
  return workspace;
}

async function markLinearWorkspaceBootstrapFailed(
  input: Pick<Parameters<typeof handleWorkspaceBootstrapFailure>[0], "issue" | "workspace" | "attempt" | "config" | "commentIssue" | "moveIssue" | "writePhaseTimingEvent">,
  error: string
): Promise<void> {
  await input.commentIssue(
    input.issue,
    workspaceBootstrapFailedCommentBody({
      workspace: input.workspace,
      attemptLabel: displayAttempt(input.attempt),
      hookCommand: input.config.hooks.afterCreate ?? "workspace after_create hook",
      error
    }),
    "recovery_needed"
  );
  await input.moveIssue(input.issue, input.config.tracker.needsInputState);
  await input.writePhaseTimingEvent(input.issue, {
    phase: "needs-input",
    status: "waiting",
    label: "needs-input pause started",
    metadata: {
      needsInputState: input.config.tracker.needsInputState,
      reason: "workspace bootstrap failure",
      hookCommand: input.config.hooks.afterCreate,
      error
    }
  });
}
