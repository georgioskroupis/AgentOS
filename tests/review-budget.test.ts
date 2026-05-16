import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateReviewBudget, isReviewSplitRecommendationOpen, prepareReviewFollowUpProposal } from "../src/review-budget.js";
import { fakeIssue, fakeServiceConfig } from "./fixtures/agentos-fakes.js";
import type { HumanDecisionState, ReviewFinding, ReviewSplitRecommendation, ServiceConfig } from "../src/types.js";

describe("review budget", () => {
  it("keeps narrow mechanical findings in the bounded retry path", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxFixerIterations: 2, maxReviewIterations: 3 }),
      iteration: 1,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:01.000Z",
      changedFiles: ["src/orchestrator.ts"],
      previousFindings: [],
      currentFindings: [finding({ reviewer: "self", file: "src/orchestrator.ts", line: 12, body: "Fix this deterministic branch." })],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 0,
      validation: undefined
    });

    expect(result.budget.status).toBe("within_budget");
    expect(result.shouldRecommendSplit).toBe(false);
  });

  it("recommends split work for repeated broad architecture findings", () => {
    const previous = finding({ reviewer: "architecture", body: "Architecture boundary remains too broad.", findingHash: "arch-1" });
    const current = finding({ reviewer: "architecture", body: "Architecture and lifecycle scope still spans too many modules.", findingHash: "arch-2" });
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ repeatedBroadCategoryThreshold: 2 }),
      iteration: 2,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:02.000Z",
      changedFiles: ["src/orchestrator.ts"],
      previousFindings: [previous],
      currentFindings: [current],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 1,
      validation: undefined
    });

    expect(result.shouldRecommendSplit).toBe(true);
    expect(result.splitRecommendation?.signals.map((signal) => signal.name)).toContain("repeated_broad_categories");
  });

  it("uses large changed-file count as a split signal", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxChangedFiles: 2 }),
      iteration: 1,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:01.000Z",
      changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      previousFindings: [],
      currentFindings: [],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 0,
      validation: undefined
    });

    expect(result.shouldRecommendSplit).toBe(true);
    expect(result.splitRecommendation?.signals[0]).toMatchObject({ name: "changed_file_count", classification: "broad" });
  });

  it("uses review elapsed time as a split signal", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxReviewElapsedMs: 1 }),
      iteration: 1,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:00.010Z",
      changedFiles: ["src/a.ts"],
      previousFindings: [],
      currentFindings: [],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 0,
      validation: undefined
    });

    expect(result.shouldRecommendSplit).toBe(true);
    expect(result.splitRecommendation?.signals[0].name).toBe("review_elapsed_ms");
  });

  it("accounts for token volume, validation reruns, and late new P1/P2 findings after approval", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxReviewTokens: 100, maxValidationReruns: 0 }),
      iteration: 1,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:01.000Z",
      changedFiles: ["src/a.ts"],
      previousFindings: [],
      currentFindings: [finding({ severity: "P2", findingHash: "late-new" })],
      repeatedFindingHashes: [],
      reviewTokenTotal: 101,
      fixerIterations: 0,
      validation: {
        status: "passed",
        checkedAt: "2026-05-16T00:00:00.000Z",
        acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-16T00:00:00.000Z", finishedAt: "2026-05-16T00:00:01.000Z" }],
        failedHistoricalAttempts: [{ name: "npm run agent-check", exitCode: 1, startedAt: "2026-05-16T00:00:00.000Z", finishedAt: "2026-05-16T00:00:01.000Z" }]
      },
      initialReviewStatus: "approved"
    });

    expect(result.splitRecommendation?.signals.map((signal) => signal.name)).toEqual(
      expect.arrayContaining(["review_token_total", "validation_reruns", "late_new_p1_p2_after_approval"])
    );
  });

  it("counts additional passing validation commands as reruns", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxValidationReruns: 1, maxReviewIterations: 3 }),
      iteration: 1,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:01.000Z",
      changedFiles: ["src/a.ts"],
      previousFindings: [],
      currentFindings: [],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 0,
      validation: {
        status: "passed",
        checkedAt: "2026-05-16T00:00:00.000Z",
        acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-16T00:00:00.000Z", finishedAt: "2026-05-16T00:00:01.000Z" }],
        additionalPassingCommands: [
          { name: "npm test -- tests/review-budget.test.ts", exitCode: 0, startedAt: "2026-05-16T00:00:01.000Z", finishedAt: "2026-05-16T00:00:02.000Z" },
          { name: "npm run typecheck", exitCode: 0, startedAt: "2026-05-16T00:00:02.000Z", finishedAt: "2026-05-16T00:00:03.000Z" }
        ]
      }
    });

    expect(result.splitRecommendation?.signals).toContainEqual(
      expect.objectContaining({ name: "validation_reruns", current: 2, threshold: 1 })
    );
  });

  it("recommends split work when broad findings reach the review-iteration budget", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxReviewIterations: 3, maxFixerIterations: 5 }),
      iteration: 3,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:03.000Z",
      changedFiles: ["src/orchestrator.ts"],
      previousFindings: [],
      currentFindings: [
        finding({
          reviewer: "architecture",
          body: "Architecture lifecycle boundaries are still too broad for another cheap fixer turn.",
          findingHash: "architecture-budget-limit"
        })
      ],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 2,
      validation: undefined
    });

    expect(result.shouldRecommendSplit).toBe(true);
    expect(result.splitRecommendation?.signals).toContainEqual(
      expect.objectContaining({ name: "review_iteration_count", classification: "broad", current: 3, threshold: 3 })
    );
  });

  it("emits mechanical fixer and finding-count signals without recommending split work", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxFixerIterations: 1, maxBlockingFindings: 2, maxP1P2Findings: 1, maxReviewIterations: 5 }),
      iteration: 2,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:02.000Z",
      changedFiles: ["src/orchestrator.ts"],
      previousFindings: [],
      currentFindings: [
        finding({ reviewer: "self", severity: "P1", file: "src/orchestrator.ts", line: 10, body: "Narrow deterministic branch still fails.", findingHash: "mechanical-1" }),
        finding({ reviewer: "tests", severity: "P2", file: "tests/orchestrator.test.ts", line: 20, body: "Narrow assertion needs updating.", findingHash: "mechanical-2" }),
        finding({ reviewer: "correctness", severity: "P0", file: "src/orchestrator.ts", line: 30, body: "Narrow null handling bug.", findingHash: "mechanical-3" })
      ],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 1,
      validation: undefined
    });

    expect(result.budget.status).toBe("exceeded");
    expect(result.shouldRecommendSplit).toBe(false);
    expect(result.budget.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fixer_iteration_count", classification: "mechanical", current: 1, threshold: 1 }),
        expect.objectContaining({ name: "blocking_finding_count", classification: "mechanical", current: 3, threshold: 2 }),
        expect.objectContaining({ name: "p1_p2_finding_count", classification: "mechanical", current: 2, threshold: 1 })
      ])
    );
  });

  it("does not treat narrow mechanical findings as broad because of status or workflow file paths", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxFixerIterations: 1, maxBlockingFindings: 1, maxP1P2Findings: 1, maxReviewIterations: 5 }),
      iteration: 2,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:02.000Z",
      changedFiles: ["src/status.ts", "src/workflow.ts"],
      previousFindings: [],
      currentFindings: [
        finding({ reviewer: "self", severity: "P1", file: "src/status.ts", line: 10, body: "Narrow null handling still fails.", findingHash: "mechanical-status-path" }),
        finding({ reviewer: "tests", severity: "P2", file: "src/workflow.ts", line: 20, body: "Narrow assertion needs updating.", findingHash: "mechanical-workflow-path" })
      ],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 1,
      validation: undefined
    });

    expect(result.budget.status).toBe("exceeded");
    expect(result.shouldRecommendSplit).toBe(false);
    expect(result.budget.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fixer_iteration_count", classification: "mechanical" }),
        expect.objectContaining({ name: "blocking_finding_count", classification: "mechanical" }),
        expect.objectContaining({ name: "p1_p2_finding_count", classification: "mechanical" })
      ])
    );
  });

  it("emits broad fixer and finding-count signals as split work", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxFixerIterations: 1, maxBlockingFindings: 2, maxP1P2Findings: 1, maxReviewIterations: 5 }),
      iteration: 2,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:02.000Z",
      changedFiles: ["src/orchestrator.ts"],
      previousFindings: [],
      currentFindings: [
        finding({ reviewer: "architecture", severity: "P1", file: "src/orchestrator.ts", line: 10, body: "Architecture lifecycle boundary is still too broad.", findingHash: "broad-1" }),
        finding({ reviewer: "architecture", severity: "P2", file: "src/status.ts", line: 20, body: "Status workflow ownership remains broad.", findingHash: "broad-2" }),
        finding({ reviewer: "architecture", severity: "P0", file: "src/workflow.ts", line: 30, body: "Workflow orchestration scope is too broad.", findingHash: "broad-3" })
      ],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 1,
      validation: undefined
    });

    expect(result.shouldRecommendSplit).toBe(true);
    expect(result.splitRecommendation?.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fixer_iteration_count", classification: "broad", current: 1, threshold: 1 }),
        expect.objectContaining({ name: "blocking_finding_count", classification: "broad", current: 3, threshold: 2 }),
        expect.objectContaining({ name: "p1_p2_finding_count", classification: "broad", current: 2, threshold: 1 })
      ])
    );
  });

  it("keeps split recommendations open until a newer supervisor decision is recorded", () => {
    const recommendation: ReviewSplitRecommendation = {
      recommended: true,
      action: "recommend-only",
      reason: "review budget exceeded for broad or non-mechanical signals",
      summary: "Recommend split or follow-up work for AG-1: repeated_broad_categories.",
      signals: [{ name: "repeated_broad_categories", classification: "broad", current: 2, threshold: 2, summary: "Repeated broad review categories: architecture." }],
      recordedAt: "2026-05-16T00:05:00.000Z"
    };
    const oldDecision = decision({ type: "approve_as_is", decidedAt: "2026-05-16T00:01:00.000Z" });
    const freshDecision = decision({ type: "split_follow_up", decidedAt: "2026-05-16T00:06:00.000Z" });

    expect(isReviewSplitRecommendationOpen({ splitRecommendation: recommendation, humanDecisions: [oldDecision], lastHumanDecision: oldDecision })).toBe(true);
    expect(isReviewSplitRecommendationOpen({ splitRecommendation: recommendation, humanDecisions: [oldDecision, freshDecision], lastHumanDecision: freshDecision })).toBe(false);
  });

  it("prepares a linked follow-up proposal when configured", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-review-budget-proposal-"));
    const issue = fakeIssue({ url: "https://linear.test/AG-1" });
    const result = evaluateReviewBudget({
      issue,
      config: config({ mode: "prepare-draft", maxChangedFiles: 1 }),
      iteration: 1,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:01.000Z",
      changedFiles: ["src/a.ts", "src/b.ts"],
      previousFindings: [],
      currentFindings: [],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 0,
      validation: undefined
    });

    const recommendation = await prepareReviewFollowUpProposal(repo, issue, result.splitRecommendation!);

    expect(recommendation.proposals?.[0].artifactPath).toBe(".agent-os/follow-ups/AG-1-review-budget.md");
    const body = await readFile(join(repo, ".agent-os", "follow-ups", "AG-1-review-budget.md"), "utf8");
    expect(body).toContain("Parent issue: AG-1 (https://linear.test/AG-1)");
    expect(body).toContain("changed_file_count");
  });

  it("keeps conservative recommend-only mode free of draft artifacts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-review-budget-recommend-"));
    const issue = fakeIssue();
    const result = evaluateReviewBudget({
      issue,
      config: config({ mode: "recommend-only", maxChangedFiles: 1 }),
      iteration: 1,
      reviewStartedAt: "2026-05-16T00:00:00.000Z",
      now: "2026-05-16T00:00:01.000Z",
      changedFiles: ["src/a.ts", "src/b.ts"],
      previousFindings: [],
      currentFindings: [],
      repeatedFindingHashes: [],
      reviewTokenTotal: 1000,
      fixerIterations: 0,
      validation: undefined
    });

    const recommendation = await prepareReviewFollowUpProposal(repo, issue, result.splitRecommendation!);

    expect(recommendation.proposals).toBeUndefined();
    await expect(access(join(repo, ".agent-os", "follow-ups", "AG-1-review-budget.md"))).rejects.toThrow();
  });
});

function config(budget: Partial<ServiceConfig["review"]["budget"]>): ServiceConfig {
  const base = fakeServiceConfig();
  return { ...base, review: { ...base.review, budget: { ...base.review.budget, ...budget } } };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    reviewer: "self",
    decision: "changes_requested",
    severity: "P1",
    file: "src/example.ts",
    line: 1,
    body: "Finding body.",
    findingHash: "finding",
    ...overrides
  };
}

function decision(overrides: Partial<HumanDecisionState> = {}): HumanDecisionState {
  return {
    type: "approve_as_is",
    source: "linear-comment",
    trusted: true,
    actor: "Supervisor",
    actorId: "user-supervisor",
    actorEmail: "supervisor@example.com",
    commentId: "comment-supervisor",
    decidedAt: "2026-05-16T00:00:00.000Z",
    ...overrides
  };
}
