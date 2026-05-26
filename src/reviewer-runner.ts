import { readOnlyReviewConfig } from "./orchestrator-review-helpers.js";
import { detectCapacityWait } from "./capacity-wait.js";
import { reviewerRole } from "./model-routing.js";
import { readReviewArtifactResult, reviewArtifactSnapshot, reviewRunnerFailureArtifact, writeReviewArtifact } from "./review.js";
import { isHumanInputStop } from "./run-errors.js";
import type { AgentEvent, AgentRunResult, AgentRunner, Issue, ModelTelemetryEntry, ReviewRunnerFailure, ServiceConfig, Workspace } from "./types.js";
import type { JsonlLogger } from "./logging.js";
import type { ReviewArtifactFailure, ReviewerArtifact } from "./review.js";

export interface ReviewerRunOutcome {
  artifact: ReviewerArtifact | null;
  canonicalArtifactPath: string;
  failures: ReviewRunnerFailure[];
  terminalFailure: ReviewRunnerFailure | null;
  tokenTotal: number;
}

export async function runReviewerWithArtifactRetry(input: {
  issue: Issue;
  prompt: string;
  attempt: number | null;
  workspace: Workspace;
  workspaceReviewDir: string;
  workspaceArtifactPath: string;
  canonicalArtifactPath: string;
  artifactRelativePath: string;
  reviewer: string;
  iteration: number;
  runId?: string | null;
  headSha?: string | null;
  signal?: AbortSignal;
  config: ServiceConfig;
  runner: AgentRunner;
  logger: JsonlLogger;
  onActivity: (issueId: string, timestamp: string) => void;
  writeRunEvent?: (runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }) => Promise<void>;
}): Promise<ReviewerRunOutcome> {
  const failures: ReviewRunnerFailure[] = [];
  const maxAttempts = input.config.agent.maxRetryAttempts + 1;
  let tokenTotal = 0;
  const modelTelemetryEntries: ModelTelemetryEntry[] = [];
  for (let reviewerAttempt = 1; reviewerAttempt <= maxAttempts; reviewerAttempt += 1) {
    const artifactBeforeAttempt = await reviewArtifactSnapshot(input.workspaceArtifactPath);
    const result = await input.runner.run({
      issue: input.issue,
      prompt: reviewerAttempt === 1 ? input.prompt : retryPrompt(input.prompt, input.artifactRelativePath, reviewerAttempt, failures[failures.length - 1]),
      attempt: input.attempt,
      workspace: input.workspace,
      config: readOnlyReviewConfig(input.config, input.workspaceReviewDir),
      modelRouting: {
        role: reviewerRole(input.reviewer),
        reviewer: input.reviewer,
        attempt: reviewerAttempt,
        artifactFailure: failures[failures.length - 1]?.reason ?? null
      },
      signal: input.signal,
      onEvent: (event) => {
        input.onActivity(input.issue.id, event.timestamp);
        void input.logger.write({ ...event, type: `review_${event.type}` });
        if (input.runId && input.writeRunEvent) void input.writeRunEvent(input.runId, { ...event, type: `review_${event.type}` });
      }
    });
    if (result.modelTelemetry && input.runId && input.writeRunEvent) {
      await input.writeRunEvent(input.runId, {
        type: "review_model_finished",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        message: `${input.reviewer} review model finished`,
        payload: { ...result.modelTelemetry, attempt: reviewerAttempt, status: result.status }
      });
    }
    const terminalRunnerFailure = nonMechanicalRunnerFailure(input, result, reviewerAttempt, maxAttempts);
    tokenTotal += result.totalTokens ?? 0;
    if (result.modelTelemetry) modelTelemetryEntries.push(result.modelTelemetry);
    if (terminalRunnerFailure) {
      failures.push(terminalRunnerFailure);
      await input.logger.write({
        type: "review_runner_failed",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        message: `${input.reviewer}: ${terminalRunnerFailure.reason}`,
        payload: terminalRunnerFailure
      });
      await writeReviewArtifact(input.canonicalArtifactPath, reviewRunnerFailureArtifact(terminalRunnerFailure));
      return { artifact: null, canonicalArtifactPath: input.canonicalArtifactPath, failures, terminalFailure: terminalRunnerFailure, tokenTotal };
    }

    const artifactResult = await readReviewArtifactResult(input.workspaceArtifactPath, input.reviewer, {
      staleIfUnchangedFrom: artifactBeforeAttempt,
      expectedRunId: input.runId,
      expectedHeadSha: input.headSha,
      expectedIteration: input.iteration
    });
    if (artifactResult.ok) {
      await writeReviewArtifact(input.canonicalArtifactPath, { ...artifactResult.artifact, modelTelemetry: modelTelemetryEntries });
      if (result.status !== "succeeded") await logRunnerFailedWithArtifact(input, result, reviewerAttempt);
      return { artifact: artifactResult.artifact, canonicalArtifactPath: input.canonicalArtifactPath, failures, terminalFailure: null, tokenTotal };
    }

    const failure = reviewerFailure(input, artifactResult.failure, result, reviewerAttempt, maxAttempts);
    failures.push(failure);
    await input.logger.write({
      type: failure.retryable ? "review_runner_retry_scheduled" : "review_runner_failed",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: `${input.reviewer}: ${failure.reason}`,
      payload: failure
    });
    if (!failure.retryable) {
      await writeReviewArtifact(input.canonicalArtifactPath, reviewRunnerFailureArtifact(failure));
      return { artifact: null, canonicalArtifactPath: input.canonicalArtifactPath, failures, terminalFailure: failure, tokenTotal };
    }
  }
  const failure = failures[failures.length - 1] ?? fallbackFailure(input, maxAttempts);
  await writeReviewArtifact(input.canonicalArtifactPath, reviewRunnerFailureArtifact(failure));
  return { artifact: null, canonicalArtifactPath: input.canonicalArtifactPath, failures, terminalFailure: failure, tokenTotal };
}

function retryPrompt(prompt: string, artifactRelativePath: string, reviewerAttempt: number, previousFailure?: ReviewRunnerFailure): string {
  return [
    prompt,
    "",
    "Reviewer runner retry context:",
    `Previous attempt ${reviewerAttempt - 1} did not produce a trusted artifact: ${previousFailure?.message ?? "unknown failure"}`,
    `Overwrite ${artifactRelativePath} with a fresh valid JSON artifact.`
  ].join("\n");
}

async function logRunnerFailedWithArtifact(input: Parameters<typeof runReviewerWithArtifactRetry>[0], result: AgentRunResult, reviewerAttempt: number): Promise<void> {
  await input.logger.write({
    type: "review_runner_failed_with_artifact",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: `${input.reviewer}: ${result.error ?? result.status}`,
    payload: { reviewer: input.reviewer, iteration: input.iteration, attempt: reviewerAttempt, resultStatus: result.status }
  });
}

function nonMechanicalRunnerFailure(
  input: Parameters<typeof runReviewerWithArtifactRetry>[0],
  result: AgentRunResult,
  reviewerAttempt: number,
  maxAttempts: number
): ReviewRunnerFailure | null {
  const runnerMessage = result.error ?? result.status;
  const capacityWait = detectCapacityWait(runnerMessage);
  if (capacityWait) {
    return {
      reviewer: input.reviewer,
      iteration: input.iteration,
      attempt: reviewerAttempt,
      maxAttempts,
      classification: "non_mechanical",
      reason: "capacity_wait",
      message: `Reviewer ${input.reviewer} hit Codex capacity before AgentOS could trust the review artifact. Next safe action: wait until ${capacityWait.resetAt} before retrying reviewer work. Runner result: ${runnerMessage}.`,
      artifactPath: input.canonicalArtifactPath,
      resultStatus: result.status,
      ...(result.error ? { runnerError: result.error } : {}),
      retryable: false,
      exhausted: false,
      recordedAt: new Date().toISOString()
    };
  }
  const runnerNeedsHuman = isHumanInputStop(runnerMessage);
  if (!runnerNeedsHuman && result.status !== "canceled") return null;
  return {
    reviewer: input.reviewer,
    iteration: input.iteration,
    attempt: reviewerAttempt,
    maxAttempts,
    classification: "non_mechanical",
    reason: runnerNeedsHuman ? "human_input_required" : "reviewer_canceled",
    message: `Reviewer ${input.reviewer} returned ${result.status} before AgentOS could trust the review artifact. Runner result: ${runnerMessage}.`,
    artifactPath: input.canonicalArtifactPath,
    resultStatus: result.status,
    ...(result.error ? { runnerError: result.error } : {}),
    retryable: false,
    exhausted: false,
    recordedAt: new Date().toISOString()
  };
}

function reviewerFailure(
  input: Parameters<typeof runReviewerWithArtifactRetry>[0],
  artifactFailure: ReviewArtifactFailure,
  result: AgentRunResult,
  reviewerAttempt: number,
  maxAttempts: number
): ReviewRunnerFailure {
  const runnerMessage = result.error ?? result.status;
  const runnerNeedsHuman = isHumanInputStop(runnerMessage);
  const classification = runnerNeedsHuman || result.status === "canceled" ? "non_mechanical" : "mechanical";
  const reason = runnerNeedsHuman
    ? "human_input_required"
    : result.status === "canceled"
      ? "reviewer_canceled"
      : result.status === "stalled"
        ? "runner_stalled"
        : result.status === "timed_out"
          ? "runner_timed_out"
          : artifactFailure.kind;
  const retryable = classification === "mechanical" && reviewerAttempt < maxAttempts;
  return {
    reviewer: input.reviewer,
    iteration: input.iteration,
    attempt: reviewerAttempt,
    maxAttempts,
    classification,
    reason,
    message: `${artifactFailure.body}${result.status !== "succeeded" ? ` Runner result: ${runnerMessage}.` : ""}`,
    artifactPath: input.canonicalArtifactPath,
    resultStatus: result.status,
    ...(result.error ? { runnerError: result.error } : {}),
    retryable,
    exhausted: classification === "mechanical" && !retryable,
    recordedAt: new Date().toISOString()
  };
}

function fallbackFailure(input: Parameters<typeof runReviewerWithArtifactRetry>[0], maxAttempts: number): ReviewRunnerFailure {
  return {
    reviewer: input.reviewer,
    iteration: input.iteration,
    attempt: maxAttempts,
    maxAttempts,
    classification: "mechanical",
    reason: "missing_artifact",
    message: `Reviewer ${input.reviewer} did not produce a trusted artifact.`,
    artifactPath: input.canonicalArtifactPath,
    retryable: false,
    exhausted: true,
    recordedAt: new Date().toISOString()
  };
}
