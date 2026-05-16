import { basename, dirname, join } from "node:path";
import { buildTargetedContextPack } from "./context-pack.js";
import { ensureDir } from "./fs-utils.js";
import type { GitHubReviewContext } from "./github-context.js";
import type { JsonlLogger } from "./logging.js";
import { blockingFindings, reviewArtifactPath, reviewArtifactRelativePath, reviewerPrompt } from "./review.js";
import { runReviewerWithArtifactRetry, type ReviewerRunOutcome } from "./reviewer-runner.js";
import type { AgentRunner, Issue, IssueState, ReviewRunnerFailure, ReviewStateReviewer, ServiceConfig, Workspace } from "./types.js";
import type { ReviewerArtifact } from "./review.js";

interface OrderedReviewerOutcome extends ReviewerRunOutcome {
  reviewer: string;
}

export interface ReviewerIterationResult {
  artifacts: Array<{ artifact: ReviewerArtifact; path: string }>;
  reviewerStates: ReviewStateReviewer[];
  reviewRunnerFailures: ReviewRunnerFailure[];
  terminalReviewerFailure: ReviewRunnerFailure | null;
  tokenTotal: number;
}

export async function runReviewerIteration(input: {
  issue: Issue;
  iteration: number;
  reviewers: string[];
  reviewPr: string;
  reviewTargetUrls: string[];
  githubContext: GitHubReviewContext;
  previousFindings: NonNullable<IssueState["findings"]>;
  latestState: IssueState | null;
  workspace: Workspace;
  repoRoot: string;
  attempt: number | null;
  signal?: AbortSignal;
  runId?: string;
  config: ServiceConfig;
  runner: AgentRunner;
  logger: JsonlLogger;
  onActivity: (issueId: string, timestamp: string) => void;
}): Promise<ReviewerIterationResult> {
  const reviewerConcurrency = reviewerConcurrencyFor(input.config, input.reviewers.length);
  const parallelReviewers = reviewerConcurrency > 1;
  const runReviewerBatch = async (batchReviewers: string[], stopOnTerminal: boolean): Promise<OrderedReviewerOutcome[]> => {
    const runReviewer = async (reviewer: string): Promise<OrderedReviewerOutcome> => {
      const canonicalArtifactRelativePath = reviewArtifactRelativePath(input.issue.identifier, input.iteration, reviewer);
      const artifactRelativePath = parallelReviewers ? isolatedReviewArtifactRelativePath(canonicalArtifactRelativePath) : canonicalArtifactRelativePath;
      const workspaceArtifactPath = join(input.workspace.path, artifactRelativePath);
      const canonicalArtifactPath = reviewArtifactPath(input.repoRoot, input.issue.identifier, input.iteration, reviewer);
      const reviewerReviewDir = dirname(workspaceArtifactPath);
      await ensureDir(reviewerReviewDir);
      const prompt = reviewerPrompt({
        issue: input.issue,
        prUrl: input.reviewPr,
        reviewTargets: input.reviewTargetUrls,
        iteration: input.iteration,
        reviewer,
        artifactPath: artifactRelativePath,
        githubSummary: input.githubContext.summary,
        feedbackSummary: input.githubContext.feedback,
        contextPack: buildTargetedContextPack({
          kind: "reviewer",
          issue: input.issue,
          state: input.latestState,
          pullRequests: input.githubContext.entries,
          findings: input.previousFindings,
          validation: input.latestState?.validation,
          feedback: input.githubContext.feedback,
          artifactRefs: [artifactRelativePath],
          runId: input.runId,
          reviewer,
          iteration: input.iteration
        })
      });
      const outcome = await runReviewerWithArtifactRetry({
        issue: input.issue,
        prompt,
        attempt: input.attempt,
        workspace: input.workspace,
        workspaceReviewDir: reviewerReviewDir,
        workspaceArtifactPath,
        canonicalArtifactPath,
        artifactRelativePath,
        reviewer,
        iteration: input.iteration,
        signal: input.signal,
        config: input.config,
        runner: input.runner,
        logger: input.logger,
        onActivity: input.onActivity
      });
      return { ...outcome, reviewer };
    };

    if (reviewerConcurrency === 1) {
      const outcomes: OrderedReviewerOutcome[] = [];
      for (const reviewer of batchReviewers) {
        const outcome = await runReviewer(reviewer);
        outcomes.push(outcome);
        if (stopOnTerminal && outcome.terminalFailure) break;
      }
      return outcomes;
    }

    return runBoundedInOrder(batchReviewers, reviewerConcurrency, runReviewer);
  };

  let reviewerOutcomes: OrderedReviewerOutcome[];
  if (parallelReviewers && input.config.review.skipOptionalReviewersAfterBlockingRequired) {
    const required = input.reviewers.filter((reviewer) => input.config.review.requiredReviewers.includes(reviewer));
    const optional = input.reviewers.filter((reviewer) => !input.config.review.requiredReviewers.includes(reviewer));
    const requiredOutcomes = await runReviewerBatch(required, false);
    if (optional.length > 0 && hasBlockingRequiredReviewerSignal(requiredOutcomes, input.config)) {
      await input.logger.write({
        type: "review_optional_reviewers_skipped",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        message: `iteration ${input.iteration}: optional reviewers skipped after required-reviewer signal`,
        payload: { optionalReviewers: optional, iteration: input.iteration }
      });
      reviewerOutcomes = requiredOutcomes;
    } else {
      reviewerOutcomes = [...requiredOutcomes, ...(await runReviewerBatch(optional, false))];
    }
  } else {
    reviewerOutcomes = await runReviewerBatch(input.reviewers, !parallelReviewers);
  }

  for (const outcome of reviewerOutcomes) {
    for (const finding of outcome.artifact?.findings ?? []) {
      await input.logger.write({
        type: "review_finding",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        message: finding.body,
        payload: finding
      });
    }
  }

  const artifacts = reviewerOutcomes.flatMap((outcome) => (outcome.artifact ? [{ artifact: outcome.artifact, path: outcome.canonicalArtifactPath }] : []));
  const terminalReviewerFailures = reviewerOutcomes.flatMap((outcome) => (outcome.terminalFailure ? [outcome.terminalFailure] : []));
  return {
    artifacts,
    reviewerStates: reviewerStatesFor(reviewerOutcomes, input.iteration),
    reviewRunnerFailures: reviewerOutcomes.flatMap((outcome) => outcome.failures),
    terminalReviewerFailure: terminalReviewerFailures[0] ?? null,
    tokenTotal: reviewerOutcomes.reduce((total, outcome) => total + outcome.tokenTotal, 0)
  };
}

export function reviewerConcurrencyFor(config: ServiceConfig, reviewerCount: number): number {
  if (!config.review.parallelReviewers) return 1;
  if (reviewerCount <= 1) return 1;
  return Math.max(1, Math.min(reviewerCount, config.review.maxConcurrentReviewers));
}

async function runBoundedInOrder<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index]);
      }
    })
  );
  return results;
}

function isolatedReviewArtifactRelativePath(canonicalRelativePath: string): string {
  return join(dirname(canonicalRelativePath), basename(canonicalRelativePath, ".json"), "review.json");
}

function hasBlockingRequiredReviewerSignal(outcomes: OrderedReviewerOutcome[], config: ServiceConfig): boolean {
  const artifacts = outcomes.flatMap((outcome) => (outcome.artifact ? [outcome.artifact] : []));
  const findings = artifacts.flatMap((artifact) => artifact.findings);
  return (
    outcomes.some((outcome) => outcome.terminalFailure) ||
    artifacts.some((artifact) => artifact.decision === "changes_requested" || artifact.decision === "human_required") ||
    findings.some((finding) => finding.decision === "human_required") ||
    blockingFindings(findings, config).length > 0
  );
}

function reviewerStatesFor(outcomes: OrderedReviewerOutcome[], iteration: number): ReviewStateReviewer[] {
  return outcomes.flatMap((outcome) => {
    if (outcome.artifact) return [{ name: outcome.artifact.reviewer, decision: outcome.artifact.decision, iteration, artifactPath: outcome.canonicalArtifactPath }];
    if (outcome.terminalFailure) return [{ name: outcome.terminalFailure.reviewer, decision: "human_required", iteration, artifactPath: outcome.terminalFailure.artifactPath ?? outcome.canonicalArtifactPath }];
    return [];
  });
}
