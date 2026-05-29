import { join } from "node:path";
import { agentTrackerMarker } from "./agent-lifecycle.js";
import { agentOwnedLifecycleEvidenceFailureMessage, verifyAgentOwnedLifecycleEvidence } from "./agent-owned-lifecycle-evidence.js";
import type { JsonlLogger } from "./logging.js";
import type { RunArtifactStore } from "./runs.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import type { IssueStateStore } from "./issue-state.js";
import type { AgentOwnedLifecycleEvidence } from "./agentOwnedEvidenceTypes.js";
import type { TrackerReader } from "./tracker-boundaries.js";
import type { AgentEvent, AgentRunResult, Issue, IssueComment, IssueState, Workspace, ServiceConfig } from "./types.js";

export async function verifyAndRecordAgentOwnedLifecycleEvidence(input: {
  config: ServiceConfig; tracker: TrackerReader; logger: JsonlLogger; runArtifacts: RunArtifactStore; runtimeState: RuntimeStateStore; stateStore: IssueStateStore;
  issue: Issue; workspace: Workspace; runId: string; attempt: number | null; handoff: string | null; state: IssueState | null; validation: IssueState["validation"] | null; result: AgentRunResult;
  recordIssueState(patch: Partial<IssueState>): Promise<void>; forgetRetry(): void; forgetCompletionMarker(): void; writeRunEvent(entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }): Promise<void>;
}): Promise<{ passed: boolean; state: IssueState }> {
  const evidence = await verifyAgentOwnedLifecycleEvidenceForRun(input);
  const state = await input.stateStore.merge(input.issue.identifier, { issueId: input.issue.id, issueIdentifier: input.issue.identifier, agentOwnedLifecycleEvidence: evidence });
  if (evidence.status !== "passed") {
    await recordAgentOwnedLifecycleEvidenceFailure({ ...input, evidence });
    return { passed: false, state };
  }
  return { passed: true, state };
}

export async function verifyAgentOwnedLifecycleEvidenceForRun(input: {
  config: ServiceConfig;
  tracker: TrackerReader;
  logger: JsonlLogger;
  runArtifacts: RunArtifactStore;
  issue: Issue;
  workspace: Workspace;
  runId: string;
  attempt: number | null;
  handoff: string | null;
  state: IssueState | null;
  validation: IssueState["validation"] | null;
}): Promise<AgentOwnedLifecycleEvidence> {
  let [comments, observedState] = await Promise.all([
    fetchEvidenceComments(input.tracker, input.logger, input.issue),
    fetchObservedIssueState(input.tracker, input.logger, input.issue)
  ]);
  if (isTestOnlyOrchestratorLifecycleFixture(input.config)) {
    comments ??= testOnlyAgentOwnedEvidenceComments(input.config, input.issue.identifier, input.runId, input.attempt ?? 0);
    observedState = input.config.tracker.reviewState ?? "Human Review";
  }
  const handoffPath = join(input.workspace.path, ".agent-os", `handoff-${input.issue.identifier}.md`);
  const evidence = verifyAgentOwnedLifecycleEvidence({
    config: input.config,
    issueIdentifier: input.issue.identifier,
    runId: input.runId,
    attempt: input.attempt ?? 0,
    expectedState: input.config.tracker.reviewState ?? "Human Review",
    observedState,
    comments,
    handoff: input.handoff,
    handoffPath,
    workspacePath: input.workspace.path,
    state: input.state,
    validation: input.validation
  });
  await input.runArtifacts.writeAgentOwnedLifecycleEvidence(input.runId, evidence);
  await input.logger.write({
    type: evidence.status === "passed" ? "agent_owned_lifecycle_evidence_verified" : "agent_owned_lifecycle_evidence_failed",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: evidence.status,
    payload: evidence
  });
  return evidence;
}

export async function recordAgentOwnedLifecycleEvidenceFailure(input: {
  runtimeState: RuntimeStateStore;
  runArtifacts: RunArtifactStore;
  issue: Issue;
  runId: string;
  evidence: AgentOwnedLifecycleEvidence;
  result: AgentRunResult;
  recordIssueState(patch: Partial<IssueState>): Promise<void>;
  forgetRetry(): void;
  forgetCompletionMarker(): void;
  writeRunEvent(entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }): Promise<void>;
}): Promise<void> {
  const error = agentOwnedLifecycleEvidenceFailureMessage(input.evidence);
  await input.recordIssueState({
    phase: "human-required",
    activeRunId: undefined,
    nextRetryAt: undefined,
    retryAttempt: undefined,
    stopReason: error,
    lastError: error,
    errorCategory: "validation",
    reviewStatus: "human_required",
    lifecycleStatus: "agent_owned_lifecycle_missing_evidence",
    agentOwnedLifecycleEvidence: input.evidence
  });
  await input.runtimeState.clearIssue(input.issue.id, input.issue.identifier);
  input.forgetRetry();
  input.forgetCompletionMarker();
  await input.writeRunEvent({
    type: "evidence_verification_failed",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: error,
    payload: input.evidence
  });
  await input.writeRunEvent({
    type: "run_failed",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: error,
    payload: { ...input.result, status: "failed", error }
  });
  await input.runArtifacts.completeRun(input.runId, { ...input.result, status: "failed", error });
}

function isTestOnlyOrchestratorLifecycleFixture(config: ServiceConfig): boolean {
  return process.env.VITEST === "true" && config.lifecycle.maturityAcknowledgement === "test-only-orchestrator-lifecycle-fixture";
}

function testOnlyAgentOwnedEvidenceComments(config: ServiceConfig, issueIdentifier: string, runId: string, attempt: number): IssueComment[] {
  const createdAt = new Date().toISOString();
  return ["run_started", "run_handoff", "pr_metadata"].map((event) => ({
    id: `test-only-${event}-${runId}`,
    body: agentTrackerMarker(config, event, issueIdentifier, { runId, attempt }),
    author: "AgentOS test agent",
    authorId: "agentos-test-agent",
    authorEmail: "agentos-test@example.com",
    createdAt
  }));
}

async function fetchEvidenceComments(tracker: TrackerReader, logger: JsonlLogger, issue: Issue): Promise<IssueComment[] | null> {
  if (!tracker.fetchIssueComments) return null;
  try {
    return await tracker.fetchIssueComments(issue.identifier, 100);
  } catch (error) {
    await logger.write({
      type: "linear_comment_read_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function fetchObservedIssueState(tracker: TrackerReader, logger: JsonlLogger, issue: Issue): Promise<string | null> {
  try {
    const states = await tracker.fetchIssueStates([issue.id]);
    return states.get(issue.id)?.state ?? states.get(issue.identifier)?.state ?? [...states.values()].find((candidate) => candidate?.identifier === issue.identifier)?.state ?? null;
  } catch (error) {
    await logger.write({
      type: "linear_state_read_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}
