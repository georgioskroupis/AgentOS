import { describe, expect, it } from "vitest";
import { evaluateLandingPreflight, githubCiFromPullRequest, landingFreshnessPatch } from "../src/landing-preflight.js";
import type { DaemonPreflightResult } from "../src/env.js";
import type { PullRequestStatus } from "../src/github.js";
import type { IssueState, ServiceConfig } from "../src/types.js";

describe("landing preflight", () => {
  it("passes when credentials, daemon freshness, validation, and CI all match the selected head", () => {
    const result = evaluateLandingPreflight({
      config: config(),
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: issueState({ validationHead: "abc123", ciHead: "abc123", ciStatus: "passed" }),
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true
    });

    expect(result).toMatchObject({ status: "ready", ready: true, reasons: [] });
  });

  it("blocks stale validation heads with an operator action", () => {
    const result = evaluateLandingPreflight({
      config: config(),
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: issueState({ validationHead: "old123", ciHead: "abc123", ciStatus: "passed" }),
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true
    });

    expect(result.status).toBe("blocked");
    expect(result.reasons.join("\n")).toContain("validation repoHead old123 is stale");
    expect(result.guidance.join("\n")).toContain("rerun validation");
  });

  it("blocks unknown check heads and waits on pending check heads", () => {
    const unknown = evaluateLandingPreflight({
      config: config(),
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: issueState({ validationHead: "abc123", ciHead: null, ciStatus: "passed" }),
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true
    });
    const pendingState = issueState({ validationHead: "abc123", ciHead: "abc123", ciStatus: "passed" });
    const pendingPr = pullRequest({ headSha: "abc123", checks: "pending" });
    const pending = evaluateLandingPreflight({
      config: config(),
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: { ...pendingState, ...landingFreshnessPatch(pendingState, pendingPr, true) },
      pullRequest: pendingPr,
      requireFreshness: true
    });

    expect(unknown.status).toBe("blocked");
    expect(unknown.reasons.join("\n")).toContain("GitHub check head is unknown");
    expect(pending.status).toBe("waiting");
    expect(pending.reasons.join("\n")).toContain("GitHub checks are pending");
  });

  it("derives current check head evidence from pull request status", () => {
    const pr = pullRequest({ headSha: "abc123", checks: "passed" });
    expect(githubCiFromPullRequest(pr, true)).toMatchObject({ status: "passed", headSha: "abc123" });
  });
});

function config(): ServiceConfig {
  return {
    trustMode: "local-trusted",
    automation: { profile: "high-throughput", repairPolicy: "mechanical-first" },
    lifecycle: {
      mode: "orchestrator-owned",
      allowedTrackerTools: [],
      idempotencyMarkerFormat: null,
      allowedStateTransitions: [],
      duplicateCommentBehavior: null,
      fallbackBehavior: null,
      maturityAcknowledgement: null,
      trustedDecisionActors: []
    },
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "lin_test",
      projectSlug: "AgentOS",
      activeStates: ["Ready"],
      terminalStates: ["Done"],
      runningState: "In Progress",
      reviewState: "Human Review",
      mergeState: "Merging",
      needsInputState: "Human Review"
    },
    polling: { intervalMs: 30000 },
    workspace: { root: ".agent-os/workspaces" },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 120000 },
    agent: { maxConcurrentAgents: 1, maxTurns: 1, maxRetryAttempts: 1, maxRetryBackoffMs: 1, maxConcurrentAgentsByState: new Map() },
    codex: { command: "codex app-server", approvalPolicy: "never", approvalEventPolicy: "deny", userInputPolicy: "deny", threadSandbox: "danger-full-access", turnSandboxPolicy: { type: "dangerFullAccess", networkAccess: true }, turnTimeoutMs: 1000, readTimeoutMs: 1000, stallTimeoutMs: 1000, passThrough: {} },
    github: { command: "gh", mergeMode: "shepherd", mergeMethod: "squash", mergeTarget: "primary", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
    review: { enabled: true, targetMode: "merge-eligible", maxIterations: 1, parallelReviewers: false, maxConcurrentReviewers: 1, skipOptionalReviewersAfterBlockingRequired: false, requiredReviewers: ["self"], optionalReviewers: [], requireAllBlockingResolved: true, blockingSeverities: ["P0", "P1", "P2"], budget: { enabled: true, mode: "recommend-only", maxReviewElapsedMs: 1, maxReviewIterations: 1, maxFixerIterations: 1, maxBlockingFindings: 1, maxP1P2Findings: 1, maxChangedFiles: 1, maxValidationReruns: 1, maxReviewTokens: 1, repeatedBroadCategoryThreshold: 1, lateNewBlockingFindingAfterApproval: true, broadCategories: [] } },
    contextBudget: { enabled: true, maxPromptTokens: 1000, maxCumulativeTokens: 1000, largeSectionTokens: 100 },
    validationBudget: { enabled: true, fullValidationCommand: "npm run agent-check", maxFullValidationRunsPerHead: 1 }
  };
}

function credentials(): DaemonPreflightResult {
  return {
    status: "ready",
    message: "ready",
    repoEnvPath: ".agent-os/env",
    repoEnvStatus: "loaded",
    loadedKeys: ["LINEAR_API_KEY"],
    errors: [],
    tracker: { linearApiKey: "present", projectSlug: "present" },
    github: { command: "configured", required: true, auth: "present" },
    codex: { command: "configured" }
  };
}

function issueState(input: { validationHead: string; ciHead: string | null; ciStatus: "passed" | "failed" | "pending" }): IssueState {
  return {
    schemaVersion: 1,
    issueId: "issue-1",
    issueIdentifier: "AG-1",
    phase: "completed",
    reviewStatus: "approved",
    headSha: "abc123",
    validation: {
      status: "passed",
      finalStatus: "passed",
      repoHead: input.validationHead,
      checkedAt: "2026-05-18T00:00:00.000Z",
      githubCi: { status: input.ciStatus, headSha: input.ciHead, checkedAt: "2026-05-18T00:00:00.000Z" }
    },
    updatedAt: "2026-05-18T00:00:00.000Z"
  };
}

function pullRequest(input: { headSha: string | null; checks: "passed" | "pending" | "failed" }): PullRequestStatus {
  return {
    url: "https://github.com/o/r/pull/1",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "agent/AG-1",
    headRepository: { owner: "o", repo: "r" },
    isCrossRepository: false,
    headSha: input.headSha,
    merged: false,
    checkSummary:
      input.checks === "passed"
        ? { total: 1, successful: 1, pending: 0, failing: 0 }
        : input.checks === "pending"
          ? { total: 1, successful: 0, pending: 1, failing: 0 }
          : { total: 1, successful: 0, pending: 0, failing: 1 },
    checkDetails: [],
    changedFiles: [],
    reviewDecision: null,
    latestReviews: [],
    comments: []
  };
}
