import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateReviewBudget, prepareReviewFollowUpProposal } from "../src/review-budget.js";
import { fakeIssue, fakeServiceConfig } from "./fixtures/agentos-fakes.js";
import type { ReviewFinding, ServiceConfig } from "../src/types.js";

describe("review budget", () => {
  it("keeps narrow mechanical findings in the bounded retry path", () => {
    const result = evaluateReviewBudget({
      issue: fakeIssue(),
      config: config({ maxFixerIterations: 2 }),
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
