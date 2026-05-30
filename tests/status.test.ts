import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { oversizedRunEventSentinels } from "./fixtures/run-event-summary.js";
import { RegistryStateStore } from "../src/registry.js";
import { JsonlLogger } from "../src/logging.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { reviewArtifactPath, writeReviewArtifact } from "../src/review.js";
import { daemonLaunchCommand, getDaemonStatus, getRegistryStatus, getStatus, inspectDaemonHealth, inspectIssue } from "../src/status.js";
import { writeDaemonIdentity } from "../src/daemon-identity.js";

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

describe("issue inspection", () => {
  it("keeps recent event rendering concise for oversized issue inspect events", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-oversized-events-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "streaming-turn",
          updatedAt: "2026-05-01T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const logger = new JsonlLogger(repo);
    await logger.write({
      type: "small_event",
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      message: "normal small event",
      timestamp: "2026-05-01T00:00:00.000Z"
    });
    await logger.write({
      type: "captured_payload",
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      message: "oversized command output",
      payload: { stdout: `${oversizedRunEventSentinels.commandOutput}\n`.repeat(500) },
      timestamp: "2026-05-01T00:00:01.000Z"
    });
    await appendFile(
      logger.logPath,
      `${JSON.stringify({
        type: "legacy_unbounded_payload",
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        message: "legacy oversized payload",
        payload: { stdout: `${oversizedRunEventSentinels.generic}\n`.repeat(500) },
        timestamp: "2026-05-01T00:00:02.000Z"
      })}\n`,
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("2026-05-01T00:00:00.000Z small_event - normal small event");
    expect(output).toContain("2026-05-01T00:00:01.000Z captured_payload - oversized command output");
    expect(output).toContain("artifact: .agent-os/runs/artifacts/");
    expect(output).toContain("2026-05-01T00:00:02.000Z legacy_unbounded_payload - legacy oversized payload [payload:");
    expect(output.length).toBeLessThan(8_000);
    for (const sentinel of Object.values(oversizedRunEventSentinels)) {
      expect(output).not.toContain(sentinel);
    }
  });

  it("shows accepted validation commands and failed historical attempts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "review",
          reviewStatus: "human_required",
          appProof: {
            updatedAt: "2026-05-01T00:02:30.000Z",
            artifacts: [{ label: "app-proof", value: ".agent-os/proof/latest-proof.md", source: "handoff" }]
          },
          lastHumanDecision: {
            type: "fix_findings",
            source: "linear-comment",
            actor: "Supervisor",
            actorId: "user-supervisor",
            actorEmail: "supervisor@example.com",
            trusted: true,
            commentId: "comment-supervisor-fix",
            decidedAt: "2026-05-01T00:02:45.000Z",
            prHeadSha: "abc123",
            ciState: "pending",
            findings: "open"
          },
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-01T00:00:00.000Z",
            acceptedCommands: [
              {
                name: "npm run agent-check",
                exitCode: 0,
                startedAt: "2026-05-01T00:01:00.000Z",
                finishedAt: "2026-05-01T00:02:00.000Z"
              }
            ],
            failedHistoricalAttempts: [
              {
                name: "npm run agent-check",
                exitCode: 1,
                startedAt: "2026-05-01T00:00:00.000Z",
                finishedAt: "2026-05-01T00:00:10.000Z"
              }
            ]
          },
          updatedAt: "2026-05-01T00:03:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Validation: passed (final: passed)");
    expect(output).toContain("Human decision: fix_findings");
    expect(output).toContain("Decision PR head SHA: abc123");
    expect(output).toContain("App proof: 2026-05-01T00:02:30.000Z");
    expect(output).toContain("app-proof: .agent-os/proof/latest-proof.md");
    expect(output).toContain("Next safe action: redispatch from Todo/In Progress");
    expect(output).toContain("Accepted validation commands:");
    expect(output).toContain("npm run agent-check: exitCode 0");
    expect(output).toContain("Failed historical attempts:");
    expect(output).toContain("npm run agent-check: exitCode 1");
  });

  it("reports whether validation evidence was reused or rerun in status and inspect", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-validation-budget-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "completed",
          validation: {
            status: "passed",
            checkedAt: "2026-05-18T00:06:00.000Z",
            githubCi: { status: "passed", headSha: "abc123", checkedAt: "2026-05-18T00:06:00.000Z", reused: true },
            budget: {
              status: "reused",
              evaluatedAt: "2026-05-18T00:06:00.000Z",
              fullValidationCommand: "npm run agent-check",
              maxFullValidationRunsPerHead: 1,
              fullValidationRunsForHead: 1,
              repoHead: "abc123",
              currentRunId: "run_current",
              evidenceRunId: "run_previous",
              summary: "Reused passing npm run agent-check evidence from matching repoHead abc123 and validation reuse profile."
            },
            reuseProfile: {
              workflowConfigHash: "hash-a",
              trustMode: "local-trusted",
              automationProfile: "high-throughput",
              automationRepairPolicy: "mechanical-first",
              riskProfile: "review=enabled|githubChecks=required"
            }
          },
          updatedAt: "2026-05-18T00:06:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const statusOutput = await getStatus(repo);
    const inspectOutput = await inspectIssue(repo, "AG-1");

    expect(statusOutput).toContain("validation evidence reused: 1/1 full run(s) for head");
    expect(inspectOutput).toContain("GitHub CI: passed (abc123) [reused]");
    expect(inspectOutput).toContain("Validation budget: reused - Reused passing npm run agent-check evidence");
    expect(inspectOutput).toContain("Validation reuse profile:");
    expect(inspectOutput).toContain("automation: high-throughput/mechanical-first");
  });

  it("summarizes context-only decision authority failures with operator next actions", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-decision-authority-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "needs-input",
          lastHumanDecision: {
            type: "fix_findings",
            source: "linear-comment",
            actor: "Supervisor",
            trusted: false,
            commentId: "comment-context-only",
            decidedAt: "2026-05-17T00:00:00.000Z"
          },
          updatedAt: "2026-05-17T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Decision authority: context-only");
    expect(output).toContain("assign the issue to this actor");
    expect(output).toContain("lifecycle.trusted_decision_actors");
  });

  it("marks stale planning scope reports as historical once an authoritative continuation is active", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-historical-scope-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "streaming-turn",
          lifecycleStatus: "human_continuation",
          lastHumanDecision: {
            type: "fix_findings",
            source: "linear-comment",
            trusted: true,
            commentId: "comment-authoritative",
            decidedAt: "2026-05-17T00:10:00.000Z"
          },
          scopeReport: {
            recordedAt: "2026-05-17T00:00:00.000Z",
            scopeSize: "large",
            likelyLarge: true,
            score: 12,
            largeThreshold: 5,
            mediumThreshold: 2,
            scoringTextSource: "issue_active_sections",
            scoringReasons: [{ score: 7, reason: "touches 7 likely subsystem(s)" }],
            ignoredSections: [],
            planningReentry: { status: "missing", reason: "prior planning pause needs an authoritative decision", decisionCommentId: null, activeScopePresent: false, activeScopeBounded: false, decompositionEvidencePresent: false },
            dispatchAdvice: { shouldBlock: true, reason: "planning re-entry needs bounded active scope", nextSafeAction: "record trusted Active-Scope" }
          },
          updatedAt: "2026-05-17T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Scope report: historical/non-blocking large");
    expect(output).toContain("prior dispatch advice is stale");
    expect(output).not.toContain("Scope dispatch advice: blocked");
  });

  it("labels validation, CI, and review artifact freshness against the selected head", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-head-freshness-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "review",
          reviewStatus: "changes_requested",
          reviewIteration: 2,
          lastRunId: "run_current",
          headSha: "current-head-sha",
          validation: {
            status: "passed",
            finalStatus: "passed",
            runId: "run_previous",
            repoHead: "current-head-sha",
            checkedAt: "2026-05-05T00:09:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-05T00:06:00.000Z", finishedAt: "2026-05-05T00:07:00.000Z" }],
            githubCi: { status: "passed", headSha: "old-ci-head", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeReviewArtifact(reviewArtifactPath(repo, "AG-1", 2, "self"), {
      reviewer: "self",
      decision: "approved",
      runId: "run_current",
      headSha: "current-head-sha",
      iteration: 2,
      modelTelemetry: [
        {
          role: "self-review",
          mode: "report-only",
          applied: false,
          configured: true,
          model: "inherited",
          reasoningEffort: null,
          proposedModel: "gpt-5.4-mini",
          proposedReasoningEffort: "low",
          costBucket: "low",
          escalationReason: null,
          refusedReason: null,
          recordedAt: "2026-05-05T00:09:00.000Z",
          elapsedMs: 42,
          tokenUsage: { total: 123 }
        }
      ],
      findings: []
    });
    await writeReviewArtifact(reviewArtifactPath(repo, "AG-1", 1, "tests"), {
      reviewer: "tests",
      decision: "changes_requested",
      runId: "run_previous",
      headSha: "old-head-sha",
      iteration: 1,
      findings: []
    });
    await writeReviewArtifact(reviewArtifactPath(repo, "AG-1", 2, "architecture"), {
      reviewer: "architecture",
      decision: "approved",
      iteration: 2,
      findings: []
    });

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-1: waiting on review (changes_requested); evidence heads:");
    expect(registryOutput).toContain("Selected PR head: current-head (current)");
    expect(registryOutput).toContain("Validation repoHead: current-head (current)");
    expect(registryOutput).toContain("CI/check head: old-ci-head (stale; expected current-head)");

    const inspectOutput = await inspectIssue(repo, "AG-1");
    expect(inspectOutput).toContain("Validation run: run_previous");
    expect(inspectOutput).toContain("Evidence heads:");
    expect(inspectOutput).toContain("Selected PR head: current-head (current)");
    expect(inspectOutput).toContain("Validation repoHead: current-head (current)");
    expect(inspectOutput).toContain("CI/check head: old-ci-head (stale; expected current-head)");
    expect(inspectOutput).toContain("iteration-2/self.json [current: iteration 2 current; run run_current current; head current-head current; model self-review=inherited proposed gpt-5.4-mini 42ms tokens 123]");
    expect(inspectOutput).toContain("iteration-1/tests.json [stale, non-authoritative: iteration 1 stale; expected 2; run run_previous stale; expected run_current; head old-head-sha stale; expected current-head]");
    expect(inspectOutput).toContain("iteration-2/architecture.json [stale, non-authoritative: run missing; expected run_current; head missing; expected current-head]");
  });

  it("does not label partially scoped review artifacts current when run and head cannot be verified", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-partial-review-scope-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "review",
          reviewStatus: "changes_requested",
          reviewIteration: 2,
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeReviewArtifact(reviewArtifactPath(repo, "AG-1", 2, "self"), {
      reviewer: "self",
      decision: "approved",
      iteration: 2,
      findings: []
    });

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("iteration-2/self.json [unknown, non-authoritative:");
    expect(output).toContain("iteration 2 current");
    expect(output).toContain("run comparison unavailable");
    expect(output).toContain("head comparison unavailable");
    expect(output).not.toContain("iteration-2/self.json [current:");
  });

  it("does not label validation or CI heads current when no selected PR head is recorded", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-no-selected-head-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "review",
          reviewStatus: "pending",
          validation: {
            status: "passed",
            finalStatus: "passed",
            repoHead: "validhead",
            checkedAt: "2026-05-05T00:09:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-05T00:06:00.000Z", finishedAt: "2026-05-05T00:07:00.000Z" }],
            githubCi: { status: "passed", headSha: "cihead", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const statusOutput = await getStatus(repo);
    expect(statusOutput).toContain("Selected PR head: unknown");
    expect(statusOutput).toContain("Validation repoHead: validhead (unknown: no selected PR head)");
    expect(statusOutput).toContain("CI/check head: cihead (unknown: no selected PR head)");

    const inspectOutput = await inspectIssue(repo, "AG-1");
    expect(inspectOutput).toContain("Selected PR head: unknown");
    expect(inspectOutput).toContain("Validation repoHead: validhead (unknown: no selected PR head)");
    expect(inspectOutput).toContain("CI/check head: cihead (unknown: no selected PR head)");
  });

  it("shows review budget split recommendations in inspect output", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-review-budget-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-2.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-2",
          issueIdentifier: "AG-2",
          phase: "review",
          reviewStatus: "human_required",
          reviewBudget: {
            status: "exceeded",
            mode: "prepare-draft",
            evaluatedAt: "2026-05-16T00:00:00.000Z",
            summary: "1 review budget signal(s) exceeded.",
            signals: [{ name: "changed_file_count", classification: "broad", current: 9, threshold: 3, summary: "9 changed file(s) exceed the review budget." }]
          },
          splitRecommendation: {
            recommended: true,
            action: "prepare-draft",
            reason: "review budget exceeded for broad or non-mechanical signals",
            summary: "Recommend split or follow-up work for AG-2: changed_file_count.",
            signals: [{ name: "changed_file_count", classification: "broad", current: 9, threshold: 3, summary: "9 changed file(s) exceed the review budget." }],
            recordedAt: "2026-05-16T00:00:00.000Z"
          },
          ciRetry: {
            status: "requested",
            updatedAt: "2026-05-16T00:00:00.000Z",
            attempts: [
              {
                status: "requested",
                attemptedAt: "2026-05-16T00:00:00.000Z",
                attempt: 1,
                maxAttempts: 2,
                prUrl: "https://github.com/o/r/pull/2",
                headSha: "abc123",
                checkNames: ["AgentOS CI"],
                runIds: ["123"],
                classification: "flaky_retryable",
                reason: "supported flaky CI retry 1 of 2"
              }
            ]
          },
          updatedAt: "2026-05-16T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-2");

    expect(output).toContain("Review budget: exceeded (prepare-draft)");
    expect(output).toContain("Split recommendation: prepare-draft");
    expect(output).toContain("Next safe action: record a split-follow-up decision");
  });

  it("labels active recommend-only review budget split recommendations as advisory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-review-budget-active-advisory-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-2.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-2",
          issueIdentifier: "AG-2",
          phase: "fix",
          reviewStatus: "changes_requested",
          reviewBudget: {
            status: "exceeded",
            mode: "recommend-only",
            evaluatedAt: "2026-05-16T00:00:00.000Z",
            summary: "1 review budget signal(s) exceeded.",
            signals: [{ name: "review_token_total", classification: "broad", current: 250000, threshold: 200000, summary: "Review/fix token volume is 250000." }]
          },
          splitRecommendation: {
            recommended: true,
            action: "recommend-only",
            reason: "review budget exceeded for broad or non-mechanical signals",
            summary: "Recommend split or follow-up work for AG-2: review_token_total.",
            signals: [{ name: "review_token_total", classification: "broad", current: 250000, threshold: 200000, summary: "Review/fix token volume is 250000." }],
            recordedAt: "2026-05-16T00:00:00.000Z"
          },
          updatedAt: "2026-05-16T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-2");

    expect(output).toContain("Split recommendation: advisory (recommend-only)");
    expect(output).toContain("Next safe action: continue bounded mechanical repair when safe");
  });

  it("labels approved review budget split recommendations as advisory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-review-budget-advisory-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-2.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-2",
          issueIdentifier: "AG-2",
          phase: "completed",
          reviewStatus: "approved",
          prs: [{ url: "https://github.com/o/r/pull/2", role: "primary", source: "handoff", discoveredAt: "2026-05-16T00:00:00.000Z" }],
          reviewBudget: {
            status: "exceeded",
            mode: "recommend-only",
            evaluatedAt: "2026-05-16T00:00:00.000Z",
            summary: "1 review budget signal(s) exceeded.",
            signals: [{ name: "changed_file_count", classification: "broad", current: 9, threshold: 3, summary: "9 changed file(s) exceed the review budget." }]
          },
          splitRecommendation: {
            recommended: true,
            action: "recommend-only",
            reason: "review budget exceeded for broad or non-mechanical signals",
            summary: "Recommend split or follow-up work for AG-2: changed_file_count.",
            signals: [{ name: "changed_file_count", classification: "broad", current: 9, threshold: 3, summary: "9 changed file(s) exceed the review budget." }],
            recordedAt: "2026-05-16T00:00:00.000Z"
          },
          updatedAt: "2026-05-16T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const statusOutput = await getStatus(repo);
    const inspectOutput = await inspectIssue(repo, "AG-2");

    expect(statusOutput).not.toContain("AG-2: split recommended");
    expect(statusOutput).not.toContain("AG-2: waiting on flaky CI retry");
    expect(statusOutput).toContain("AG-2: waiting on merge");
    expect(inspectOutput).toContain("Split recommendation: advisory (recommend-only)");
    expect(inspectOutput).not.toContain("Next safe action: record a split-follow-up decision");
    expect(inspectOutput).toContain("Next safe action: mark the PR ready only after fresh validation and green CI");
  });

  it("treats terminal child issues with advisory split telemetry as closed out", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-terminal-child-advisory-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "VER-80.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-80",
          issueIdentifier: "VER-80",
          phase: "completed",
          lifecycleStatus: "terminal_linear",
          terminalState: "Done",
          terminalAt: "2026-05-18T10:00:00.000Z",
          splitRecommendation: {
            recommended: true,
            action: "recommend-only",
            reason: "review budget exceeded for broad or non-mechanical signals",
            summary: "Recommend split or follow-up work for VER-80: review_token_total, repeated_broad_categories.",
            signals: [
              { name: "review_token_total", classification: "broad", current: 220000, threshold: 200000, summary: "Review/fix token volume is 220000." },
              { name: "repeated_broad_categories", classification: "broad", current: 2, threshold: 2, summary: "Repeated broad review categories: architecture." }
            ],
            recordedAt: "2026-05-18T09:30:00.000Z"
          },
          updatedAt: "2026-05-18T10:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const statusOutput = await getStatus(repo);
    const inspectOutput = await inspectIssue(repo, "VER-80");

    expect(statusOutput).toContain("VER-80: terminal (Done)");
    expect(statusOutput).not.toContain("VER-80: split recommended");
    expect(inspectOutput).toContain("Split recommendation: advisory (recommend-only)");
    expect(inspectOutput).toContain("Next safe action: no operator action required; issue is already in terminal state Done");
    expect(inspectOutput).not.toContain("Next safe action: record a split-follow-up decision");
    expect(inspectOutput).toContain("Status warnings: none");
  });

  it("does not keep asking for split follow-up after an authoritative split decision", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-review-budget-resolved-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-3.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-3",
          issueIdentifier: "AG-3",
          phase: "review",
          reviewStatus: "human_required",
          lifecycleStatus: "supervisor_continuation",
          splitRecommendation: {
            recommended: true,
            action: "recommend-only",
            reason: "review budget exceeded for broad or non-mechanical signals",
            summary: "Recommend split or follow-up work for AG-3: changed_file_count.",
            signals: [{ name: "changed_file_count", classification: "broad", current: 9, threshold: 3, summary: "9 changed file(s) exceed the review budget." }],
            recordedAt: "2026-05-16T00:00:00.000Z"
          },
          lastHumanDecision: {
            type: "split_follow_up",
            source: "linear-comment",
            trusted: true,
            actor: "Supervisor",
            actorId: "user-supervisor",
            actorEmail: "supervisor@example.com",
            commentId: "comment-split",
            decidedAt: "2026-05-16T00:05:00.000Z",
            validationEvidence: ".agent-os/validation/AG-3.json",
            ciState: "passed",
            findings: "accepted",
            summary: "follow-up issue linked"
          },
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-16T00:04:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-16T00:03:00.000Z", finishedAt: "2026-05-16T00:04:00.000Z" }]
          },
          updatedAt: "2026-05-16T00:05:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-3");

    expect(output).toContain("Human decision: split_follow_up");
    expect(output).toContain("Next safe action: keep Codex paused; move to Merging only when remaining risk is accepted and required validation/CI evidence is fresh");
    expect(output).not.toContain("Next safe action: record a split-follow-up decision");
  });

  it("shows registry project health, CI wait state, daemon freshness, and validation timing splits", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-registry-status-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: agent-owned",
        "  allowed_tracker_tools:",
        "    - scripts/agent-linear-comment.sh",
        "    - scripts/agent-linear-move.sh",
        "    - scripts/agent-linear-pr.sh",
        "    - scripts/agent-linear-handoff.sh",
        "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
        "  allowed_state_transitions:",
        "    - Todo -> In Progress",
        "    - In Progress -> Human Review",
        "  duplicate_comment_behavior: upsert",
        "  fallback_behavior: write handoff and stop human_required",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "agent:",
        "  max_concurrent_agents: 2",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(
      registryPath,
      ["version: 1", "defaults:", "  maxConcurrency: 2", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md", "    maxConcurrency: 1"].join("\n"),
      "utf8"
    );
    await new RegistryStateStore(registryPath).write({
      schemaVersion: 1,
      updatedAt: "2026-05-05T00:10:00.000Z",
      cursor: 0,
      globalConcurrency: 2,
      projects: [
        {
          name: "alpha",
          repoRoot: repo,
          workflowPath: join(repo, "WORKFLOW.md"),
          status: "transient_tracker_error",
          checkedAt: "2026-05-05T00:10:00.000Z",
          activeRuns: 0,
          retryQueue: 0,
          claimedIssues: 0,
          maxConcurrency: 1,
          lastSuccessfulTrackerReadAt: "2026-05-05T00:00:00.000Z",
          lastError: "fetch failed",
          errorCategory: "tracker_network"
        }
      ]
    });
    await new RuntimeStateStore(repo).setDaemon({
      startedAt: "2026-05-05T00:00:00.000Z",
      startGitSha: "old",
      startMainGitSha: "old",
      currentGitSha: "new",
      currentMainGitSha: "new",
      workflowPath: join(repo, "WORKFLOW.md"),
      freshnessStatus: "stale",
      freshnessMessage: "main advanced from old to new; run git pull && bin/agent-os daemon restart",
      preflightStatus: "missing_credentials",
      preflightMessage: "tracker.api_key is required after environment resolution",
      repoEnvPath: join(repo, ".agent-os", "env"),
      repoEnvStatus: "missing"
    });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "completed",
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-05T00:06:00.000Z", finishedAt: "2026-05-05T00:07:00.000Z" }],
            additionalPassingCommands: [
              { name: "npm test -- tests/runner.test.ts tests/agent-lifecycle-cli.test.ts", exitCode: 0, startedAt: "2026-05-05T00:03:00.000Z", finishedAt: "2026-05-05T00:04:00.000Z" }
            ],
            failedHistoricalAttempts: [{ name: "npm run agent-check", exitCode: 1, startedAt: "2026-05-05T00:01:00.000Z", finishedAt: "2026-05-05T00:02:00.000Z" }],
            githubCi: { status: "passed", headSha: "abc123", checkedAt: "2026-05-05T00:05:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-2.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-2",
          issueIdentifier: "AG-2",
          phase: "merge",
          reviewStatus: "approved",
          workspacePath: ".agent-os/workspaces/AG-2",
          headSha: "abc123",
          prs: [{ url: "https://github.com/o/r/pull/2", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            githubCi: { status: "pending", headSha: "abc123", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-3.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-3",
          issueIdentifier: "AG-3",
          phase: "completed",
          headSha: "def456",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            githubCi: { status: "passed", headSha: "def456", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-4.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-4",
          issueIdentifier: "AG-4",
          phase: "completed",
          lifecycleStatus: "human_continuation",
          reviewStatus: "approved",
          prs: [{ url: "https://github.com/o/r/pull/4", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          lastHumanDecision: {
            type: "fix_findings",
            source: "linear-comment",
            trusted: true,
            commentId: "comment-old-fix-findings",
            decidedAt: "2026-05-05T00:01:00.000Z"
          },
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            githubCi: { status: "passed", headSha: "ghi789", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new JsonlLogger(repo).write({
      type: "merge_waiting",
      issueId: "issue-2",
      issueIdentifier: "AG-2",
      message: "1 GitHub check(s) still pending"
    });

    const output = await getRegistryStatus(registryPath);

    expect(output).toContain("alpha: transient_tracker_error");
    expect(output).toContain("Config: trust=danger; lifecycle=agent-owned; automation=high-throughput/mechanical-first");
    expect(output).toContain("Error: tracker_network - fetch failed");
    expect(output).toContain("Daemon: stale - main advanced from old to new; run git pull && bin/agent-os daemon restart");
    expect(output).toContain("Daemon preflight: missing_credentials - tracker.api_key is required after environment resolution");
    expect(output).toContain("Repo env: missing");
    expect(output).toContain("AG-2: waiting on CI - 1 GitHub check(s) still pending");
    expect(output).toContain("AG-3: completed locally");
    expect(output).toContain("AG-4: waiting on merge");
    expect(output).not.toContain("AG-4: human_continuation");
    expect(output).not.toContain("AG-2: status warning");
    expect(output).not.toContain("AG-3: status warning");
    expect(output).toContain("AG-1: local full-suite validation timing failure recorded separately; focused test passed; GitHub CI passed at abc123");
  });

  it("summarizes plugin/cache stderr warning noise without dumping raw logs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-warning-noise-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "needs-input",
          updatedAt: "2026-05-17T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new JsonlLogger(repo).write({
      type: "review_codex_stderr",
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      message: "Plugin manifest warning noisy details that should not appear in status output"
    });

    const statusOutput = await getStatus(repo);
    const inspectOutput = await inspectIssue(repo, "AG-1");

    expect(statusOutput).toContain("AG-1: runtime warning noise - 1 plugin/cache stderr warning event(s) recorded");
    expect(statusOutput).not.toContain("noisy details");
    expect(inspectOutput).toContain("Runtime warning summary: 1 plugin/cache stderr warning event(s) recorded");
    expect(inspectOutput).not.toContain("noisy details");
  });

  it("keeps benign plugin stderr diagnostics out of active runtime warning summaries", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-benign-warning-noise-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "completed",
          lifecycleStatus: "merge_success",
          updatedAt: "2026-05-17T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new JsonlLogger(repo).write({
      type: "codex_stderr_benign",
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      message: "Plugin manifest warning noisy details that should not appear in status output",
      payload: { classification: "benign_plugin_warning", capturedChars: 80 }
    });

    const statusOutput = await getStatus(repo);
    const inspectOutput = await inspectIssue(repo, "AG-1");

    expect(statusOutput).not.toContain("runtime warning noise");
    expect(statusOutput).not.toContain("noisy details");
    expect(inspectOutput).toContain("Runtime warning summary: none recorded");
    expect(inspectOutput).toContain("benign plugin/cache stderr warning omitted from status output");
    expect(inspectOutput).not.toContain("noisy details");
  });

  it("does not recommend redispatch after old fix-findings once a PR is approved", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-approved-pr-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "completed",
          lifecycleStatus: "human_continuation",
          reviewStatus: "approved",
          prs: [{ url: "https://github.com/o/r/pull/1", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          lastHumanDecision: {
            type: "fix_findings",
            source: "linear-comment",
            trusted: true,
            commentId: "comment-old-fix-findings",
            decidedAt: "2026-05-05T00:01:00.000Z"
          },
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            githubCi: { status: "passed", headSha: "abc123", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Review: approved");
    expect(output).toContain("Next safe action: mark the PR ready only after fresh validation and green CI, then move the issue to Merging for the shepherd");
    expect(output).not.toContain("Next safe action: redispatch from Todo/In Progress");
  });

  it("surfaces external Human Review state drift in status and inspect output", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-external-state-drift-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "human-required",
          reviewStatus: "human_required",
          externalStateDrift: {
            status: "reconciled",
            expectedState: "Human Review",
            currentState: "In Progress",
            detectedAt: "2026-05-08T21:15:00.000Z",
            reconciledAt: "2026-05-08T21:16:00.000Z",
            reason: "local AgentOS state still requires Human Review",
            nextAction: "keep the issue in Human Review; record a trusted structured human decision before returning it to an active implementation state",
            reconciliation: "moved_to_expected_state"
          },
          updatedAt: "2026-05-08T21:16:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const statusOutput = await getStatus(repo);
    const inspectOutput = await inspectIssue(repo, "AG-1");

    expect(statusOutput).toContain("AG-1: status warning - external state drift: expected Human Review, observed In Progress; reconciled back to Human Review");
    expect(statusOutput).toContain("record a trusted structured human decision before returning it to an active implementation state");
    expect(inspectOutput).toContain("External state drift: reconciled");
    expect(inspectOutput).toContain("Expected tracker state: Human Review");
    expect(inspectOutput).toContain("Observed tracker state: In Progress");
    expect(inspectOutput).toContain("Status warnings:");
  });

  it("reports daemon liveness states and status next safe actions", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-health-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });

    const stopped = await getStatus(repo);
    expect(stopped).toContain("Daemon: stopped - no daemon PID file is present");
    expect(stopped).toContain("Next safe action: bin/agent-os daemon start");

    await writeFile(join(repo, ".agent-os", "daemon.pid"), "999999\n", "utf8");
    await writeFile(join(repo, ".agent-os", "daemon.log"), "", "utf8");
    const failed = await inspectDaemonHealth(repo);
    expect(failed.status).toBe("failed_launch");
    expect(failed.nextSafeAction).toContain("remove");
    expect(failed.nextSafeAction).toContain("daemon start");

    await writeFile(join(repo, ".agent-os", "daemon.pid"), "999998\n", "utf8");
    await writeFile(join(repo, ".agent-os", "daemon.log"), "previous daemon output\n", "utf8");
    const stalePid = await inspectDaemonHealth(repo);
    expect(stalePid.status).toBe("stale_pid");
    expect(stalePid.message).toContain("pid 999998 is not running");
    expect(stalePid.nextSafeAction).toContain("remove");

    await writeFile(join(repo, ".agent-os", "daemon.pid"), `${process.pid}\n`, "utf8");
    const nonAgentosPid = await inspectDaemonHealth(repo);
    expect(nonAgentosPid.status).toBe("non_agentos_pid");
    expect(nonAgentosPid.message).toContain("cannot verify it as this repo's daemon");
    expect(nonAgentosPid.nextSafeAction).toContain("do not run daemon start/restart");
    expect(nonAgentosPid.nextSafeAction).toContain("confirmed safe");

    await writeDaemonIdentity(repo, { pid: process.pid, startedAt: "2026-05-05T00:00:00.000Z", startGitSha: "abc123" });
    await new RuntimeStateStore(repo).setDaemon({
      startedAt: "2026-05-05T00:00:00.000Z",
      workflowPath: join(repo, "WORKFLOW.md"),
      preflightStatus: "ready",
      preflightMessage: "loaded repo env",
      repoEnvPath: join(repo, ".agent-os", "env"),
      repoEnvStatus: "loaded"
    });
    const healthy = await inspectDaemonHealth(repo);
    expect(healthy.status).toBe("healthy");
    expect(healthy.message).toContain("credential preflight is ready");
    expect(healthy.nextSafeAction).toContain("no operator action required");

    await new RuntimeStateStore(repo).setDaemon({
      startedAt: "2026-05-05T00:00:00.000Z",
      startMainGitSha: "old",
      currentMainGitSha: "new",
      workflowPath: join(repo, "WORKFLOW.md"),
      freshnessStatus: "stale",
      freshnessMessage: "main advanced from old to new; run git pull && bin/agent-os daemon restart",
      preflightStatus: "ready"
    });
    const stale = await inspectDaemonHealth(repo);
    expect(stale.status).toBe("stale_freshness");
    expect(stale.nextSafeAction).toContain("run git pull && bin/agent-os daemon restart");
    expect(stale.nextSafeAction).toContain(`--repo '${repo}'`);
    const daemonStatus = await getDaemonStatus(repo);
    expect(daemonStatus).toContain("Daemon: stale_freshness - main advanced from old to new; run git pull && bin/agent-os daemon restart");
    expect(daemonStatus).toContain("Run events:");
    expect(daemonStatus).toContain(".agent-os/runs/agent-os.jsonl");
    expect(daemonStatus).toContain("Crash log:");
    expect(daemonStatus).toContain(".agent-os/daemon.log");
    expect(daemonStatus).toContain("only for crash investigations");
    expect(daemonStatus).toContain("Daemon freshness: stale - main advanced from old to new; run git pull && bin/agent-os daemon restart");

    const launchCommand = daemonLaunchCommand(repo);
    expect(launchCommand).toContain("AGENT_OS_DAEMON_LOG");
    expect(launchCommand).toContain("AGENT_OS_DAEMON_START_GIT_SHA");
  });

  it("shows recoverable partial work, stale PR heads, stale CI heads, and one next action", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-recovery-"));
    const workspace = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await run("git", ["init", "-b", "main"], workspace);
    await run("git", ["config", "user.email", "agentos@example.test"], workspace);
    await run("git", ["config", "user.name", "AgentOS Test"], workspace);
    await writeFile(join(workspace, "README.md"), "initial\n", "utf8");
    await run("git", ["add", "README.md"], workspace);
    await run("git", ["commit", "-m", "initial"], workspace);
    await writeFile(join(workspace, "README.md"), "dirty local fix\n", "utf8");

    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "needs-input",
          reviewStatus: "human_required",
          lastError: "codex_stall_timeout",
          workspacePath: workspace,
          headSha: "recorded-pr-head",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:00:00.000Z",
            githubCi: { status: "failed", headSha: "ci-head", checkedAt: "2026-05-05T00:00:00.000Z" }
          },
          updatedAt: "2026-05-05T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Workspace recovery: recoverable partial work");
    expect(output).toContain("workspace has uncommitted changes");
    expect(output).toContain("branch has no upstream");
    expect(output).toContain("differs from recorded PR head recorded-pr-head");
    expect(output).toContain("differs from recorded CI head ci-head");
    expect(output).toContain(`Next safe action: resume ${workspace}`);
  });

  it("does not present completed clean pushed recovery as actionable operator work", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-completed-clean-pushed-"));
    const workspace = join(repo, ".agent-os", "workspaces", "AG-1");
    const remote = join(repo, "remote.git");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await run("git", ["init", "--bare", remote], repo);
    await run("git", ["init", "-b", "main"], workspace);
    await run("git", ["config", "user.email", "agentos@example.test"], workspace);
    await run("git", ["config", "user.name", "AgentOS Test"], workspace);
    await writeFile(join(workspace, "README.md"), "initial\n", "utf8");
    await run("git", ["add", "README.md"], workspace);
    await run("git", ["commit", "-m", "initial"], workspace);
    await run("git", ["remote", "add", "origin", remote], workspace);
    await run("git", ["push", "-u", "origin", "main"], workspace);
    await run("git", ["checkout", "-b", "agent/AG-1"], workspace);
    await writeFile(join(workspace, "README.md"), "implemented\n", "utf8");
    await run("git", ["add", "README.md"], workspace);
    await run("git", ["commit", "-m", "implement AG-1"], workspace);
    const headSha = await run("git", ["rev-parse", "HEAD"], workspace);
    await run("git", ["push", "-u", "origin", "agent/AG-1"], workspace);

    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "completed",
          reviewStatus: "pending",
          workspacePath: workspace,
          headSha,
          prs: [{ url: "https://github.com/o/r/pull/1", role: "primary", source: "handoff", discoveredAt: "2026-05-21T00:00:00.000Z" }],
          prUrl: "https://github.com/o/r/pull/1",
          validation: { status: "passed", repoHead: headSha, checkedAt: "2026-05-21T00:00:00.000Z" },
          updatedAt: "2026-05-21T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).not.toContain("Workspace recovery: recoverable partial work");
    expect(output).not.toContain("recover the existing pushed branch");
    expect(output).toContain("Next safe action: review the selected PR and move the Linear issue to Merging when approved");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports recoverable terminal workspace drift as a read-only status warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-terminal-workspace-drift-"));
    const repo = join(root, "alpha");
    const workspace = join(repo, ".agent-os", "workspaces", "AG-8");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await run("git", ["init", "-b", "agent/AG-8"], workspace);
    await run("git", ["config", "user.email", "agentos@example.test"], workspace);
    await run("git", ["config", "user.name", "AgentOS Test"], workspace);
    await writeFile(join(workspace, "README.md"), "initial\n", "utf8");
    await run("git", ["add", "README.md"], workspace);
    await run("git", ["commit", "-m", "initial"], workspace);
    await writeFile(join(workspace, "README.md"), "dirty terminal drift\n", "utf8");
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-8.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-8",
          issueIdentifier: "AG-8",
          phase: "completed",
          lifecycleStatus: "terminal_linear",
          terminalState: "Done",
          terminalAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "approved",
          workspacePath: ".agent-os/workspaces/AG-8",
          headSha: "recorded-head",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "passed", headSha: "recorded-head", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-8: status warning - terminal workspace drift:");
    expect(registryOutput).toContain("workspace has uncommitted changes");
    expect(registryOutput).not.toContain("AG-8: recoverable partial work");

    const inspectOutput = await inspectIssue(repo, "AG-8");
    expect(inspectOutput).toContain("Status warnings:");
    expect(inspectOutput).toContain("terminal workspace drift: terminal issue still points to recoverable workspace");
    expect(inspectOutput).toContain("workspace has uncommitted changes");
    expect(inspectOutput).toContain("Next safe action: verify the terminal PR/Linear evidence");
    expect(inspectOutput).not.toContain(`Next safe action: resume ${workspace}`);
    expect(inspectOutput).not.toContain("Workspace recovery: recoverable partial work");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reports terminal-state contradictions and post-merge cleanup drift as status warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-terminal-drift-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-3.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-3",
          issueIdentifier: "AG-3",
          phase: "completed",
          lifecycleStatus: "post_merge_cleanup_warning",
          terminalState: "Done",
          terminalAt: "2026-05-05T00:10:00.000Z",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "human_required",
          lastError: "codex_stall_timeout",
          errorCategory: "stall",
          retryAttempt: 2,
          nextRetryAt: "2026-05-05T00:20:00.000Z",
          workspacePath: ".agent-os/workspaces/AG-3",
          headSha: "new-head-sha",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "failed", headSha: "old-ci-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          mergeCleanupWarnings: [
            "Local branch cleanup failed for agent/AG-3: branch is checked out at /tmp/worktree",
            "Remote branch cleanup failed for agent/AG-3: remote rejected delete"
          ],
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: "issue-3",
      identifier: "AG-3",
      issue: {
        id: "issue-3",
        identifier: "AG-3",
        title: "Terminal drift",
        description: null,
        priority: 1,
        state: "Done",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null
      },
      attempt: 3,
      dueAt: "2026-05-05T00:30:00.000Z",
      error: "stale retry queue",
      scheduledAt: "2026-05-05T00:15:00.000Z"
    });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-7.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-7",
          issueIdentifier: "AG-7",
          phase: "completed",
          lifecycleStatus: "merge_success",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "approved",
          headSha: "merged-head-sha",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "passed", headSha: "merged-head-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: "issue-7",
      identifier: "AG-7",
      issue: {
        id: "issue-7",
        identifier: "AG-7",
        title: "Clean terminal retry drift",
        description: null,
        priority: 1,
        state: "Done",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null
      },
      attempt: 1,
      dueAt: "2026-05-05T00:40:00.000Z",
      error: "stale clean retry queue",
      scheduledAt: "2026-05-05T00:25:00.000Z"
    });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-9.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-9",
          issueIdentifier: "AG-9",
          phase: "completed",
          lifecycleStatus: "merge_success",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "approved",
          headSha: "merged-head-sha",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "passed", headSha: "merged-head-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new RuntimeStateStore(repo).upsertActiveRun({
      issueId: "issue-9",
      identifier: "AG-9",
      issue: {
        id: "issue-9",
        identifier: "AG-9",
        title: "Clean terminal active-run drift",
        description: null,
        priority: 1,
        state: "Done",
        branch_name: null,
        url: null,
        labels: [],
        blocked_by: [],
        created_at: null,
        updated_at: null
      },
      attempt: 1,
      runId: "run_20260505000000_AG-9_stale",
      startedAt: "2026-05-05T00:00:00.000Z",
      lastEventAt: "2026-05-05T00:01:00.000Z",
      phase: "streaming-turn"
    });

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-3: status warning - contradictory terminal state: terminal issue still has reviewStatus human_required");
    expect(registryOutput).not.toContain("AG-3: retrying after stale retry queue");
    expect(registryOutput).toContain("AG-7: status warning - merge/retry drift: terminal issue still has retry queue entry for 2026-05-05T00:40:00.000Z");
    expect(registryOutput).not.toContain("AG-7: retrying after stale clean retry queue");
    expect(registryOutput).toContain("AG-9: status warning - active-run drift: terminal issue still has active runtime state for run_20260505000000_AG-9_stale (streaming-turn)");
    expect(registryOutput).not.toContain("AG-9: running");

    const inspectOutput = await inspectIssue(repo, "AG-3");
    expect(inspectOutput).toContain("Status warnings:");
    expect(inspectOutput).toContain("contradictory terminal state: terminal issue still has reviewStatus human_required");
    expect(inspectOutput).toContain("stale error metadata remains (stall) - codex_stall_timeout");
    expect(inspectOutput).toContain("stale validation/CI head SHA old-ci-sha differs from recorded head new-head-sha");
    expect(inspectOutput).toContain("terminal issue still records GitHub CI as failed");
    expect(inspectOutput).toContain("merge/retry drift: terminal issue still has retry metadata for 2026-05-05T00:20:00.000Z");
    expect(inspectOutput).toContain("post-merge cleanup drift: selected PR is merged but AgentOS branch cleanup warning remains");
    expect(inspectOutput).toContain("Next safe action: verify the terminal PR/Linear evidence");
    expect(inspectOutput).not.toContain("record `AgentOS-Human-Decision: fix-findings`");

    const inspectRetryOnlyOutput = await inspectIssue(repo, "AG-7");
    expect(inspectRetryOnlyOutput).toContain("Status warnings:");
    expect(inspectRetryOnlyOutput).toContain("merge/retry drift: terminal issue still has retry queue entry for 2026-05-05T00:40:00.000Z");
    expect(inspectRetryOnlyOutput).toContain("Next safe action: verify the terminal PR/Linear evidence");
    expect(inspectRetryOnlyOutput).not.toContain("Status warnings: none");
    expect(inspectRetryOnlyOutput).not.toContain("retrying after stale clean retry queue");

    const inspectActiveOnlyOutput = await inspectIssue(repo, "AG-9");
    expect(inspectActiveOnlyOutput).toContain("Status warnings:");
    expect(inspectActiveOnlyOutput).toContain("active-run drift: terminal issue still has active runtime state for run_20260505000000_AG-9_stale (streaming-turn)");
    expect(inspectActiveOnlyOutput).toContain("Next safe action: verify the terminal PR/Linear evidence");
    expect(inspectActiveOnlyOutput).not.toContain("Status warnings: none");
  });

  it("keeps completed local handoffs on the non-terminal status path without explicit terminal evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-completed-local-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-4.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-4",
          issueIdentifier: "AG-4",
          phase: "completed",
          reviewStatus: "human_required",
          lastError: "codex_stall_timeout",
          errorCategory: "stall",
          workspacePath: ".agent-os/workspaces/AG-4",
          headSha: "new-head-sha",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "failed", headSha: "old-ci-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-4: waiting on Human Review - codex_stall_timeout");
    expect(registryOutput).not.toContain("AG-4: status warning");

    const output = await inspectIssue(repo, "AG-4");

    expect(output).toContain("Status warnings: none");
    expect(output).toContain("Next safe action: record `AgentOS-Human-Decision: fix-findings`");
    expect(output).not.toContain("contradictory terminal state");
    expect(output).not.toContain("stale validation/CI head SHA old-ci-sha");
    expect(output).not.toContain("terminal issue still records GitHub CI as failed");
    expect(output).not.toContain("missing terminal workspace warning");
  });

  it("renders terminal missing-workspace cleanup cleanly while active missing workspaces still warn", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-terminal-missing-clean-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const terminalCases = [
      ["AG-14", "Canceled"],
      ["AG-15", "Duplicate"]
    ] as const;
    for (const [identifier, terminalState] of terminalCases) {
      await writeFile(
        join(repo, ".agent-os", "state", "issues", `${identifier}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            issueId: `issue-${identifier}`,
            issueIdentifier: identifier,
            phase: "canceled",
            lifecycleStatus: "terminal_missing_workspace",
            terminalState,
            reviewStatus: "pending",
            workspacePath: `.agent-os/workspaces/${identifier}`,
            workspaceMissingAt: "2026-05-05T00:10:00.000Z",
            updatedAt: "2026-05-05T00:10:00.000Z"
          },
          null,
          2
        ),
        "utf8"
      );
    }
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-16.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-16",
          issueIdentifier: "AG-16",
          phase: "needs-input",
          lifecycleStatus: "implementation_failure",
          reviewStatus: "pending",
          workspacePath: ".agent-os/workspaces/AG-16",
          workspaceMissingAt: "2026-05-05T00:20:00.000Z",
          updatedAt: "2026-05-05T00:20:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const statusOutput = await getStatus(repo);
    expect(statusOutput).toContain("AG-14: terminal (Canceled)");
    expect(statusOutput).toContain("AG-15: terminal (Duplicate)");
    expect(statusOutput).not.toContain("AG-14: status warning");
    expect(statusOutput).not.toContain("AG-15: status warning");
    expect(statusOutput).toContain("AG-16: status warning - missing workspace warning:");

    const canceledOutput = await inspectIssue(repo, "AG-14");
    expect(canceledOutput).toContain("Status warnings: none");
    expect(canceledOutput).toContain("Review: none recorded");
    expect(canceledOutput).not.toContain("Review: pending");
    expect(canceledOutput).not.toContain("Workspace recovery: workspace missing");
    expect(canceledOutput).not.toContain("terminal workspace warning");

    const duplicateOutput = await inspectIssue(repo, "AG-15");
    expect(duplicateOutput).toContain("Status warnings: none");
    expect(duplicateOutput).not.toContain("Review: pending");
    expect(duplicateOutput).not.toContain("Workspace recovery: workspace missing");

    const activeOutput = await inspectIssue(repo, "AG-16");
    expect(activeOutput).toContain("Status warnings:");
    expect(activeOutput).toContain("missing workspace warning: workspacePath points to missing workspace");
    expect(activeOutput).toContain("Workspace recovery: workspace missing");
    expect(activeOutput).toContain("Review: pending");
  });

  it("names the planning/decomposition next safe action for planning-required issues", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-planning-required-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-10.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-10",
          issueIdentifier: "AG-10",
          phase: "needs-input",
          lifecycleStatus: "planning_required",
          stopReason: "likely-large scope needs planning or decomposition before implementation dispatch",
          scopeReport: {
            recordedAt: "2026-05-05T00:09:00.000Z",
            scopeSize: "large",
            likelyLarge: true,
            score: 7,
            mediumThreshold: 2,
            largeThreshold: 5,
            scoringTextSource: "issue_full_text",
            scoringReasons: [
              { score: 3, reason: "touches 3 likely subsystem(s)" },
              { score: 2, reason: "has 6 acceptance/detail bullet(s)" },
              { score: 2, reason: "contains broad orchestration or roadmap language" }
            ],
            ignoredSections: ["Background"],
            planningReentry: {
              status: "missing",
              reason: "prior planning_required pause needs bounded Active-Scope or linked decomposition evidence",
              activeScopePresent: false,
              activeScopeBounded: false,
              decompositionEvidencePresent: false
            },
            dispatchAdvice: {
              shouldBlock: true,
              reason: "likely-large scope needs planning or decomposition before implementation dispatch",
              nextSafeAction: "create or attach a planning/decomposition artifact, or split follow-up issues, before starting implementation"
            }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-10: planning required - create or attach a planning/decomposition artifact");
    expect(registryOutput).toContain("scope score 7/5");
    expect(registryOutput).toContain("+3 touches 3 likely subsystem(s)");

    const inspectOutput = await inspectIssue(repo, "AG-10");
    expect(inspectOutput).toContain("Next safe action: create or attach a planning/decomposition artifact");
    expect(inspectOutput).toContain("Scope report: large (likely large)");
    expect(inspectOutput).toContain("Scope scoring reasons:");
    expect(inspectOutput).toContain("+2 contains broad orchestration or roadmap language");
    expect(inspectOutput).toContain("Planning re-entry: missing");
  });

  it("does not warn when clean post-merge cleanup removed the recorded workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-clean-merge-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-5.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-5",
          issueIdentifier: "AG-5",
          phase: "completed",
          lifecycleStatus: "merge_success",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "approved",
          workspacePath: ".agent-os/workspaces/AG-5",
          headSha: "merged-head-sha",
          prs: [{ url: "https://github.com/o/r/pull/5", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          mergeTargetUrl: "https://github.com/o/r/pull/5",
          mergeTargetRole: "primary",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "passed", headSha: "merged-head-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-6.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-6",
          issueIdentifier: "AG-6",
          phase: "completed",
          lifecycleStatus: "already_merged_pr",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "approved",
          workspacePath: ".agent-os/workspaces/AG-6",
          headSha: "merged-head-sha",
          prs: [{ url: "https://github.com/o/r/pull/6", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          mergeTargetUrl: "https://github.com/o/r/pull/6",
          mergeTargetRole: "primary",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "passed", headSha: "merged-head-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-11.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-11",
          issueIdentifier: "AG-11",
          phase: "completed",
          lifecycleStatus: "terminal_linear",
          terminalState: "Done",
          terminalAt: "2026-05-05T00:10:00.000Z",
          workspacePath: ".agent-os/workspaces/AG-11",
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-12.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-12",
          issueIdentifier: "AG-12",
          phase: "completed",
          lifecycleStatus: "terminal_missing_workspace",
          terminalState: "Done",
          terminalAt: "2026-05-05T00:10:00.000Z",
          workspacePath: ".agent-os/workspaces/AG-12",
          workspaceMissingAt: "2026-05-05T00:10:00.000Z",
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-13.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-13",
          issueIdentifier: "AG-13",
          phase: "completed",
          lifecycleStatus: "terminal_missing_workspace",
          terminalState: "Closed",
          terminalAt: "2026-05-05T00:10:00.000Z",
          workspacePath: ".agent-os/workspaces/AG-13",
          workspaceMissingAt: "2026-05-05T00:10:00.000Z",
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-5: merged");
    expect(registryOutput).toContain("AG-6: already merged");
    expect(registryOutput).toContain("AG-11: terminal (Done)");
    expect(registryOutput).toContain("AG-12: terminal (Done)");
    expect(registryOutput).toContain("AG-13: terminal (Closed)");
    expect(registryOutput).not.toContain("AG-5: waiting on merge");
    expect(registryOutput).not.toContain("AG-6: waiting on merge");
    expect(registryOutput).not.toContain("AG-5: status warning");
    expect(registryOutput).not.toContain("AG-6: status warning");
    expect(registryOutput).not.toContain("AG-11: status warning");
    expect(registryOutput).not.toContain("AG-12: status warning");
    expect(registryOutput).not.toContain("AG-13: status warning");

    const inspectOutput = await inspectIssue(repo, "AG-5");
    expect(inspectOutput).toContain("Status warnings: none");
    expect(inspectOutput).toContain("Next safe action: no operator action required; selected PR is merged and terminal state is recorded");
    expect(inspectOutput).not.toContain("move the issue to Merging");
    expect(inspectOutput).not.toContain("missing terminal workspace warning");
    expect(inspectOutput).not.toContain("Workspace recovery: workspace missing");
    expect(inspectOutput).not.toContain("Recovery reasons: workspace is missing");
    expect(inspectOutput).not.toContain("inspect runtime state and recover from the last handoff or run artifact");

    const alreadyMergedOutput = await inspectIssue(repo, "AG-6");
    expect(alreadyMergedOutput).toContain("Status warnings: none");
    expect(alreadyMergedOutput).toContain("Next safe action: no operator action required; selected PR is already merged and terminal state is recorded");
    expect(alreadyMergedOutput).not.toContain("move the issue to Merging");
    expect(alreadyMergedOutput).not.toContain("missing terminal workspace warning");
    expect(alreadyMergedOutput).not.toContain("Workspace recovery: workspace missing");
    expect(alreadyMergedOutput).not.toContain("Recovery reasons: workspace is missing");
    expect(alreadyMergedOutput).not.toContain("inspect runtime state and recover from the last handoff or run artifact");

    const terminalLinearOutput = await inspectIssue(repo, "AG-11");
    expect(terminalLinearOutput).toContain("Status warnings: none");
    expect(terminalLinearOutput).toContain("Next safe action: no operator action required; issue is already in terminal state Done");
    expect(terminalLinearOutput).not.toContain("missing terminal workspace warning");
    expect(terminalLinearOutput).not.toContain("Workspace recovery: workspace missing");

    const terminalMissingOutput = await inspectIssue(repo, "AG-12");
    expect(terminalMissingOutput).toContain("Status warnings: none");
    expect(terminalMissingOutput).toContain("Next safe action: no operator action required; issue is already in terminal state Done");
    expect(terminalMissingOutput).not.toContain("terminal workspace warning");
    expect(terminalMissingOutput).not.toContain("Workspace recovery: workspace missing");

    const configuredDoneStateOutput = await inspectIssue(repo, "AG-13");
    expect(configuredDoneStateOutput).toContain("Status warnings: none");
    expect(configuredDoneStateOutput).toContain("Next safe action: no operator action required; issue is already in terminal state Closed");
    expect(configuredDoneStateOutput).not.toContain("terminal workspace warning");
    expect(configuredDoneStateOutput).not.toContain("Workspace recovery: workspace missing");
  });

  it("renders branch freshness details for updated and report-only branch-update decisions", async () => {
    // VER-94 certification: operator-visible status/inspect output explains each
    // branch-update decision clearly (updated vs report-only). Covers
    // branchUpdateDetails() wired into inspectIssue().
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-branch-update-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });

    await writeFile(
      join(stateRoot, "AG-UPD.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-upd",
          issueIdentifier: "AG-UPD",
          branchUpdate: {
            status: "updated",
            updatedAt: "2026-05-19T20:13:47.000Z",
            prUrl: "https://github.com/o/r/pull/70",
            reason: "The pull request branch is stale and eligible for a bounded same-repository update.",
            operatorGuidance: "Run one safe branch update, then refresh PR head, checks, and validation freshness before merge progression.",
            mergeStateStatus: "BEHIND",
            beforeHeadSha: "old-head-1234567890ab",
            afterHeadSha: "new-head-1234567890ab"
          },
          updatedAt: "2026-05-19T20:13:47.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(stateRoot, "AG-RPT.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-rpt",
          issueIdentifier: "AG-RPT",
          branchUpdate: {
            status: "report_only",
            updatedAt: "2026-05-19T20:14:00.000Z",
            prUrl: "https://github.com/o/r/pull/71",
            reason: "The pull request has merge conflicts.",
            operatorGuidance: "Report only: resolve the merge conflict outside AgentOS' bounded branch update path.",
            mergeStateStatus: "DIRTY",
            beforeHeadSha: "abc1234567890def"
          },
          updatedAt: "2026-05-19T20:14:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(stateRoot, "AG-NONE.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-none",
          issueIdentifier: "AG-NONE",
          updatedAt: "2026-05-19T20:15:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const updatedOutput = await inspectIssue(repo, "AG-UPD");
    expect(updatedOutput).toContain("Branch freshness: updated (2026-05-19T20:13:47.000Z)");
    expect(updatedOutput).toContain("- PR: https://github.com/o/r/pull/70");
    expect(updatedOutput).toContain("- Head before: old-head-123");
    expect(updatedOutput).toContain("- Head after: new-head-123");
    expect(updatedOutput).toContain("- GitHub merge state: BEHIND");

    const reportOnlyOutput = await inspectIssue(repo, "AG-RPT");
    expect(reportOnlyOutput).toContain("Branch freshness: report_only (2026-05-19T20:14:00.000Z)");
    expect(reportOnlyOutput).toContain("- GitHub merge state: DIRTY");
    expect(reportOnlyOutput).toContain("- Reason: The pull request has merge conflicts.");
    expect(reportOnlyOutput).toContain("- Next: Report only: resolve the merge conflict");

    const noneOutput = await inspectIssue(repo, "AG-NONE");
    expect(noneOutput).toContain("Branch freshness: none recorded");
  });
});

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolvePromise();
    });
  });
}
