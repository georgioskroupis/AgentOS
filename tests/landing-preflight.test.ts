import { describe, expect, it } from "vitest";
import { planBranchFreshnessUpdate } from "../src/branch-update.js";
import { evaluateLandingPreflight, githubCiFromPullRequest, landingFreshnessPatch } from "../src/landing-preflight.js";
import { validationReuseProfileForConfig } from "../src/validation-profile.js";
import type { DaemonPreflightResult } from "../src/env.js";
import type { PullRequestStatus } from "../src/github.js";
import type { IssueState, ServiceConfig } from "../src/types.js";

const LANDING_NOW = new Date("2026-05-18T00:10:00.000Z");

describe("landing preflight", () => {
  it("passes when credentials, daemon freshness, validation, and CI all match the selected head", () => {
    const result = evaluateLandingPreflight({
      config: config(),
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: issueState({ validationHead: "abc123", ciHead: "abc123", ciStatus: "passed" }),
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true,
      now: LANDING_NOW
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
      requireFreshness: true,
      now: LANDING_NOW
    });

    expect(result.status).toBe("blocked");
    expect(result.reasons.join("\n")).toContain("validation repoHead old123 is stale");
    expect(result.guidance.join("\n")).toContain("rerun validation");
  });

  it("blocks landing when daemon freshness is stale", () => {
    const result = evaluateLandingPreflight({
      config: config(),
      daemon: {
        startedAt: "2026-05-18T00:00:00.000Z",
        workflowPath: "WORKFLOW.md",
        freshnessStatus: "stale",
        freshnessMessage: "main advanced from old to new; run git pull && bin/agent-os daemon restart"
      },
      credentials: credentials(),
      state: issueState({ validationHead: "abc123", ciHead: "abc123", ciStatus: "passed" }),
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true,
      now: LANDING_NOW
    });

    expect(result.status).toBe("blocked");
    expect(result.reasons.join("\n")).toContain("main advanced from old to new");
    expect(result.guidance.join("\n")).toContain("git pull && bin/agent-os daemon restart");
  });

  it("blocks unknown check heads and waits on pending check heads", () => {
    const unknown = evaluateLandingPreflight({
      config: config(),
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: issueState({ validationHead: "abc123", ciHead: null, ciStatus: "passed" }),
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true,
      now: LANDING_NOW
    });
    const pendingState = issueState({ validationHead: "abc123", ciHead: "abc123", ciStatus: "passed" });
    const pendingPr = pullRequest({ headSha: "abc123", checks: "pending" });
    const pending = evaluateLandingPreflight({
      config: config(),
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: { ...pendingState, ...landingFreshnessPatch(pendingState, pendingPr, true, LANDING_NOW) },
      pullRequest: pendingPr,
      requireFreshness: true,
      now: LANDING_NOW
    });

    expect(unknown.status).toBe("blocked");
    expect(unknown.reasons.join("\n")).toContain("GitHub check head is unknown");
    expect(pending.status).toBe("waiting");
    expect(pending.reasons.join("\n")).toContain("GitHub checks are pending");
  });

  it("derives current check head evidence from pull request status", () => {
    const pr = pullRequest({ headSha: "abc123", checks: "passed" });
    expect(githubCiFromPullRequest(pr, true, LANDING_NOW)).toMatchObject({ status: "passed", headSha: "abc123", reused: false, checkedAt: LANDING_NOW.toISOString() });
  });

  it("reuses unchanged-head validation and CI evidence when the profile and timestamps are fresh", () => {
    const serviceConfig = config();
    const state = reusedIssueState(serviceConfig, {
      validationHead: "abc123",
      ciHead: "abc123",
      validationFinishedAt: "2026-05-18T00:05:00.000Z",
      ciCheckedAt: "2026-05-18T00:06:00.000Z"
    });
    const pr = pullRequest({ headSha: "abc123", checks: "passed" });
    const patched = { ...state, ...landingFreshnessPatch(state, pr, true, LANDING_NOW) };

    const result = evaluateLandingPreflight({
      config: serviceConfig,
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: patched,
      pullRequest: pr,
      requireFreshness: true,
      now: LANDING_NOW
    });

    expect(result.ready).toBe(true);
    expect(patched.validation?.githubCi?.reused).toBe(true);
  });

  it("blocks validation evidence when stale or missing current profile metadata", () => {
    const serviceConfig = config();
    const missingProfileState = issueState({ validationHead: "abc123", ciHead: "abc123", ciStatus: "passed" });
    delete missingProfileState.validation!.reuseProfile;
    const missingProfile = evaluateLandingPreflight({
      config: serviceConfig,
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: missingProfileState,
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true,
      now: LANDING_NOW
    });
    const stale = evaluateLandingPreflight({
      config: serviceConfig,
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: reusedIssueState(serviceConfig, {
        validationHead: "abc123",
        ciHead: "abc123",
        validationFinishedAt: "2026-05-16T00:05:00.000Z",
        ciCheckedAt: "2026-05-16T00:06:00.000Z"
      }),
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true,
      now: LANDING_NOW
    });
    const changedProfileState = reusedIssueState(serviceConfig, {
      validationHead: "abc123",
      ciHead: "abc123",
      validationFinishedAt: "2026-05-18T00:05:00.000Z",
      ciCheckedAt: "2026-05-18T00:06:00.000Z"
    });
    changedProfileState.validation!.reuseProfile = {
      ...changedProfileState.validation!.reuseProfile!,
      workflowConfigHash: "old-config",
      riskProfile: "old-risk"
    };
    const changedProfile = evaluateLandingPreflight({
      config: serviceConfig,
      daemon: { startedAt: "2026-05-18T00:00:00.000Z", workflowPath: "WORKFLOW.md", freshnessStatus: "fresh" },
      credentials: credentials(),
      state: changedProfileState,
      pullRequest: pullRequest({ headSha: "abc123", checks: "passed" }),
      requireFreshness: true,
      now: LANDING_NOW
    });

    expect(missingProfile.status).toBe("blocked");
    expect(missingProfile.reasons.join("\n")).toContain("validation evidence is missing workflow/config");
    expect(stale.status).toBe("blocked");
    expect(stale.reasons.join("\n")).toContain("npm run agent-check reuse evidence is stale");
    expect(stale.reasons.join("\n")).toContain("GitHub CI reuse evidence is stale");
    expect(changedProfile.status).toBe("blocked");
    expect(changedProfile.reasons.join("\n")).toContain("workflow/config hash changed");
    expect(changedProfile.reasons.join("\n")).toContain("risk profile changed");
  });

  it("changes the reuse profile when codex approval policy changes", () => {
    const baseline = config();
    const changed = config();
    changed.codex = { ...changed.codex, approvalPolicy: "on-request" };

    expect(validationReuseProfileForConfig(changed).workflowConfigHash).not.toBe(validationReuseProfileForConfig(baseline).workflowConfigHash);
  });

  it("keeps the reuse profile stable when only the local workspace root changes", () => {
    const baseline = config();
    const relocated = config();
    relocated.workspace = { root: "/tmp/agent-os/workspaces" };

    expect(validationReuseProfileForConfig(relocated).workflowConfigHash).toBe(validationReuseProfileForConfig(baseline).workflowConfigHash);
  });

  it("classifies stale same-repository AgentOS branches as safe to update", () => {
    const result = planBranchFreshnessUpdate(config(), pullRequest({ headSha: "abc123", checks: "passed", mergeStateStatus: "BEHIND" }));

    expect(result).toMatchObject({
      action: "update",
      mergeStateStatus: "BEHIND"
    });
    expect(result.operatorGuidance).toContain("refresh PR head");
  });

  it("keeps stale branches report-only when the update path is unsafe or not configured", () => {
    const conservative = config();
    conservative.automation = { ...conservative.automation, profile: "conservative" };
    conservative.github = { ...conservative.github, mergeMode: "manual" };
    const unsafeBranch = planBranchFreshnessUpdate(config(), {
      ...pullRequest({ headSha: "abc123", checks: "passed", mergeStateStatus: "BEHIND" }),
      headRefName: "main"
    });
    const disabledPolicy = planBranchFreshnessUpdate(conservative, pullRequest({ headSha: "abc123", checks: "passed", mergeStateStatus: "BEHIND" }));

    expect(unsafeBranch.action).toBe("report-only");
    expect(unsafeBranch.reason).toContain("cannot update it safely");
    expect(disabledPolicy.action).toBe("report-only");
    expect(disabledPolicy.reason).toContain("high-throughput landing is not enabled");
  });

  it("reports merge conflict, protected branch, and merge queue blockers without branch updates", () => {
    const conflict = planBranchFreshnessUpdate(config(), pullRequest({ headSha: "abc123", checks: "passed", mergeStateStatus: "DIRTY" }));
    const protectedBranch = planBranchFreshnessUpdate(config(), pullRequest({ headSha: "abc123", checks: "passed", mergeStateStatus: "BLOCKED" }));
    const mergeQueue = planBranchFreshnessUpdate(config(), {
      ...pullRequest({ headSha: "abc123", checks: "passed", mergeStateStatus: "CLEAN" }),
      checkDetails: [{ name: "merge queue", status: "COMPLETED", conclusion: "FAILURE", url: "https://github.com/o/r/actions/runs/1" }]
    });

    expect(conflict).toMatchObject({ action: "report-only" });
    expect(conflict.reason).toContain("merge conflicts");
    expect(protectedBranch).toMatchObject({ action: "report-only" });
    expect(protectedBranch.reason).toContain("branch protection");
    expect(mergeQueue).toMatchObject({ action: "report-only" });
    expect(mergeQueue.reason).toContain("protected branch or merge queue");
  });
});

function config(): ServiceConfig {
  return {
    trustMode: "local-trusted",
    automation: { profile: "high-throughput", repairPolicy: "mechanical-first" },
    lifecycle: {
      mode: "orchestrator-owned",
      allowedTrackerTools: [],
      clientTrackerTools: [],
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
    github: { command: "gh", mergeMode: "shepherd", mergeMethod: "squash", mergeTarget: "primary", baseBranch: "main", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
    daemon: { mainBranchRefreshIntervalTicks: 5 },
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
      githubCi: { status: input.ciStatus, headSha: input.ciHead, checkedAt: "2026-05-18T00:00:00.000Z" },
      reuseProfile: validationReuseProfileForConfig(config())
    },
    updatedAt: "2026-05-18T00:00:00.000Z"
  };
}

function reusedIssueState(
  serviceConfig: ServiceConfig,
  input: { validationHead: string; ciHead: string; validationFinishedAt: string; ciCheckedAt: string }
): IssueState {
  const state = issueState({ validationHead: input.validationHead, ciHead: input.ciHead, ciStatus: "passed" });
  state.validation = {
    ...state.validation!,
    acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: input.validationFinishedAt, finishedAt: input.validationFinishedAt }],
    githubCi: { status: "passed", headSha: input.ciHead, checkedAt: input.ciCheckedAt, reused: true },
    budget: {
      status: "reused",
      evaluatedAt: "2026-05-18T00:07:00.000Z",
      fullValidationCommand: "npm run agent-check",
      maxFullValidationRunsPerHead: 1,
      fullValidationRunsForHead: 1,
      repoHead: input.validationHead,
      currentRunId: "run_current",
      evidenceRunId: "run_previous",
      summary: "Reused passing npm run agent-check evidence."
    },
    reuseProfile: validationReuseProfileForConfig(serviceConfig)
  };
  return state;
}

function pullRequest(input: { headSha: string | null; checks: "passed" | "pending" | "failed"; mergeStateStatus?: string | null }): PullRequestStatus {
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
    mergeStateStatus: input.mergeStateStatus ?? "CLEAN",
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
