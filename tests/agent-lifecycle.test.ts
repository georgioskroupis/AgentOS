import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSupervisorValidationEvidence,
  attachPrWithAgentLifecycleTool,
  buildSupervisorDecisionBody,
  commentWithAgentLifecycleTool,
  moveWithAgentLifecycleTool,
  recordHandoffWithAgentLifecycleTool,
  supervisorDecisionEvent
} from "../src/agent-lifecycle.js";
import type { AgentLifecycleTracker } from "../src/agent-lifecycle.js";
import type { LinearCommentWriteResult, LinearIssueReference } from "../src/linear.js";
import type { ServiceConfig } from "../src/types.js";
import { writeValidationEvidence } from "../src/validation.js";
import type { ValidationEvidence } from "../src/validation.js";
import { validationReuseProfileForConfig } from "../src/validation-profile.js";

describe("agent lifecycle tools", () => {
  it("allows configured agent tracker comments with stable markers and redaction", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-"));
    const tracker = new MemoryTracker();
    const token = linearToken();

    const result = await commentWithAgentLifecycleTool(
      { repoRoot: repo, config: lifecycleConfig(), tracker },
      {
        issue: "AG-1",
        event: "status_update",
        tool: "scripts/agent-linear-comment.sh",
        body: `Done with token ${token}`
      }
    );

    expect(result).toMatchObject({
      status: "created",
      issueIdentifier: "AG-1",
      marker: "<!-- agentos:event=status_update issue=AG-1 -->"
    });
    expect(tracker.comments).toEqual([
      {
        issue: "AG-1",
        marker: "<!-- agentos:event=status_update issue=AG-1 -->",
        body: "Done with token [REDACTED]",
        duplicateBehavior: "upsert"
      }
    ]);
  });

  it("correlates agent-owned lifecycle comments with issue, run, and attempt markers", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-correlation-"));
    const tracker = new MemoryTracker();

    const result = await commentWithAgentLifecycleTool(
      {
        repoRoot: repo,
        config: lifecycleConfig({
          mode: "agent-owned",
          idempotencyMarkerFormat: "<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->"
        }),
        tracker
      },
      {
        issue: "AG-1",
        event: "status_update",
        tool: "scripts/agent-linear-comment.sh",
        body: "Done",
        runId: "run-123",
        attempt: 2
      }
    );

    expect(result).toMatchObject({
      status: "created",
      issueIdentifier: "AG-1",
      runId: "run-123",
      attempt: 2,
      marker: "<!-- agentos:event=status_update issue=AG-1 run=run-123 attempt=2 -->"
    });
    expect(tracker.comments[0]).toMatchObject({
      marker: "<!-- agentos:event=status_update issue=AG-1 run=run-123 attempt=2 -->"
    });
  });

  it("requires agent-owned run and attempt correlation before lookup or writes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-correlation-required-"));
    const tracker = new MemoryTracker();

    await expect(
      commentWithAgentLifecycleTool(
        {
          repoRoot: repo,
          config: lifecycleConfig({
            mode: "agent-owned",
            idempotencyMarkerFormat: "<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->"
          }),
          tracker
        },
        { issue: "AG-1", event: "status_update", tool: "scripts/agent-linear-comment.sh", body: "handoff" }
      )
    ).rejects.toThrow("lifecycle.mode=agent-owned requires --run-id");

    expect(tracker.lookups).toEqual([]);
    expect(tracker.comments).toEqual([]);
  });

  it("returns run and attempt correlation for agent-owned moves", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-move-correlation-"));
    const tracker = new MemoryTracker({ state: "In Progress" });

    const result = await moveWithAgentLifecycleTool(
      {
        repoRoot: repo,
        config: lifecycleConfig({
          mode: "agent-owned",
          idempotencyMarkerFormat: "<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->"
        }),
        tracker
      },
      { issue: "AG-1", state: "Human Review", tool: "scripts/agent-linear-move.sh", runId: "run-123", attempt: 1 }
    );

    expect(result).toEqual({
      status: "moved",
      issueIdentifier: "AG-1",
      marker: "<!-- agentos:event=state_transition issue=AG-1 run=run-123 attempt=1 -->",
      runId: "run-123",
      attempt: 1
    });
    expect(tracker.moves).toEqual([{ issue: "AG-1", state: "Human Review" }]);
  });

  it("rejects disallowed tracker state transitions before moving the issue", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-transition-"));
    const tracker = new MemoryTracker({ state: "In Progress" });
    await expect(
      moveWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        { issue: "AG-1", state: "Done", tool: "scripts/agent-linear-move.sh" }
      )
    ).rejects.toThrow("disallowed_tracker_state_transition: In Progress -> Done");
    expect(tracker.moves).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "handoff-AG-1.md"), "utf8")).rejects.toThrow();
  });

  it("writes a fallback handoff with the resolved issue identifier when tracker writes fail", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-fallback-"));
    const tracker = new MemoryTracker();
    const token = linearToken();
    tracker.failComment = new Error(`Linear rejected ${token}`);

    await expect(
      commentWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        { issue: "issue-1", event: "status_update", tool: "scripts/agent-linear-comment.sh", body: "handoff" }
      )
    ).rejects.toThrow("agent_tracker_tool_failed: comment: Linear rejected [REDACTED]");

    const fallback = await readFile(join(repo, ".agent-os", "handoff-AG-1.md"), "utf8");
    expect(fallback).toContain("AgentOS-Outcome: partially-satisfied");
    expect(fallback).toContain("Tracker Tool Fallback");
    expect(fallback).toContain("- Issue: AG-1");
    expect(fallback).toContain("Linear rejected [REDACTED]");
    expect(fallback).not.toContain(token);
    await expect(readFile(join(repo, ".agent-os", "handoff-issue-1.md"), "utf8")).rejects.toThrow();
  });

  it("rejects orchestrator-owned tracker writes before lookup, tracker writes, or fallback", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-owned-"));
    const tracker = new MemoryTracker();

    await expect(
      commentWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig({ mode: "orchestrator-owned" }), tracker },
        { issue: "AG-1", event: "status_update", tool: "scripts/agent-linear-comment.sh", body: "handoff" }
      )
    ).rejects.toThrow("lifecycle.mode=orchestrator-owned rejects agent tracker writes");

    expect(tracker.lookups).toEqual([]);
    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "handoff-AG-1.md"), "utf8")).rejects.toThrow();
  });

  it("rejects default agent mode moves under orchestrator-owned policy before lookup or writes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-owned-move-"));
    const tracker = new MemoryTracker();

    await expect(
      moveWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig({ mode: "orchestrator-owned" }), tracker },
        { issue: "AG-1", state: "Merging", tool: "scripts/agent-linear-move.sh" }
      )
    ).rejects.toThrow("lifecycle.mode=orchestrator-owned rejects agent tracker writes");

    expect(tracker.lookups).toEqual([]);
    expect(tracker.moves).toEqual([]);
  });

  it("allows explicit supervisor moves under orchestrator-owned policy after identifier and known-state validation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-supervisor-move-"));
    const tracker = new MemoryTracker({ state: "Human Review" });

    const result = await moveWithAgentLifecycleTool(
      { repoRoot: repo, config: lifecycleConfig({ mode: "orchestrator-owned" }), tracker },
      {
        issue: "AG-1",
        state: "Merging",
        tool: "scripts/agent-linear-move.sh",
        supervisor: true
      }
    );

    expect(result).toEqual({ status: "moved", issueIdentifier: "AG-1" });
    expect(tracker.lookups).toEqual(["AG-1"]);
    expect(tracker.moves).toEqual([{ issue: "AG-1", state: "Merging" }]);
  });

  it("rejects supervisor moves for unknown identifiers without writing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-supervisor-missing-"));
    const tracker = new MemoryTracker();
    tracker.notFound.add("AG-404");

    await expect(
      moveWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig({ mode: "orchestrator-owned" }), tracker },
        {
          issue: "AG-404",
          state: "Merging",
          tool: "scripts/agent-linear-move.sh",
          supervisor: true
        }
      )
    ).rejects.toThrow("Linear issue not found: AG-404");

    expect(tracker.lookups).toEqual(["AG-404"]);
    expect(tracker.moves).toEqual([]);
  });

  it("rejects supervisor moves to states outside the configured workflow set", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-supervisor-state-"));
    const tracker = new MemoryTracker({ state: "Human Review" });

    await expect(
      moveWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig({ mode: "orchestrator-owned" }), tracker },
        {
          issue: "AG-1",
          state: "Ready",
          tool: "scripts/agent-linear-move.sh",
          supervisor: true
        }
      )
    ).rejects.toThrow("unknown workflow state for supervisor move: Ready");

    expect(tracker.moves).toEqual([]);
  });

  it("builds supervisor decision comments in the WORKFLOW.md structured format", () => {
    const body = buildSupervisorDecisionBody({
      decisionType: "fix-findings",
      prHeadSha: "ABC1234",
      validationPath: ".agent-os/validation/AG-1.json",
      ciState: "passed",
      findings: "resolved",
      summary: "review findings are resolved",
      issueIdentifier: "AG-1"
    });

    expect(body).toBe(
      [
        "AgentOS-Human-Decision: fix-findings",
        "PR-Head-SHA: abc1234",
        "Validation-JSON: .agent-os/validation/AG-1.json",
        "CI-State: passed",
        "Findings: resolved",
        "Decision-Summary: review findings are resolved"
      ].join("\n")
    );
    expect(supervisorDecisionEvent("fix-findings", "ABC1234")).toBe("supervisor-decision:fix-findings:abc1234");
  });

  it("requires all supervisor decision fields before posting structured comments", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-supervisor-decision-"));
    const tracker = new MemoryTracker();

    await expect(
      commentWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig({ mode: "orchestrator-owned" }), tracker },
        {
          issue: "AG-1",
          event: "supervisor-decision",
          tool: "scripts/agent-linear-comment.sh",
          supervisor: true,
          body: [
            "AgentOS-Human-Decision: fix-findings",
            "PR-Head-SHA: abc1234",
            "Validation-JSON: .agent-os/validation/AG-1.json",
            "Findings: resolved",
            "Decision-Summary: missing CI state"
          ].join("\n")
        }
      )
    ).rejects.toThrow("supervisor decision requires CI-State");

    expect(tracker.comments).toEqual([]);
  });

  it("validates supervisor decision evidence reuse-profile metadata and PR head shape", () => {
    const evidence = JSON.stringify({
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      repoHead: "abc1234",
      status: "passed",
      commands: [
        {
          name: "npm run agent-check",
          exitCode: 0,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:01:00.000Z"
        }
      ],
      reuseProfile: {
        workflowConfigHash: "hash",
        trustMode: "danger",
        automationProfile: "high-throughput",
        automationRepairPolicy: "mechanical-first",
        riskProfile: "review=enabled"
      }
    });

    expect(() =>
      assertSupervisorValidationEvidence({
        evidenceText: evidence,
        validationPath: ".agent-os/validation/AG-1.json",
        issueIdentifier: "AG-1",
        prHeadSha: "abc1234"
      })
    ).not.toThrow();

    expect(() =>
      assertSupervisorValidationEvidence({
        evidenceText: evidence,
        validationPath: ".agent-os/workspaces/AG-1/.agent-os/validation/AG-1.json",
        issueIdentifier: "AG-1",
        prHeadSha: "abc1234"
      })
    ).not.toThrow();

    expect(() =>
      assertSupervisorValidationEvidence({
        evidenceText: JSON.stringify({
          schemaVersion: 1,
          issueIdentifier: "AG-1",
          repoHead: "abc1234",
          status: "passed",
          commands: [
            {
              name: "npm run agent-check",
              exitCode: 0,
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:01:00.000Z"
            }
          ]
        }),
        validationPath: ".agent-os/validation/AG-1.json",
        issueIdentifier: "AG-1",
        prHeadSha: "abc1234"
      })
    ).toThrow("supervisor validation evidence reuseProfile is required");

    expect(() =>
      assertSupervisorValidationEvidence({
        evidenceText: JSON.stringify({
          schemaVersion: 1,
          issueIdentifier: "AG-1",
          repoHead: "abc1234",
          status: "failed",
          commands: [
            {
              name: "npm run agent-check",
              exitCode: 1,
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:01:00.000Z"
            }
          ],
          reuseProfile: {
            workflowConfigHash: "hash",
            trustMode: "danger",
            automationProfile: "high-throughput",
            automationRepairPolicy: "mechanical-first",
            riskProfile: "review=enabled"
          }
        }),
        validationPath: ".agent-os/validation/AG-1.json",
        issueIdentifier: "AG-1",
        prHeadSha: "abc1234"
      })
    ).toThrow("supervisor validation evidence status must be passed");

    expect(() =>
      assertSupervisorValidationEvidence({
        evidenceText: JSON.stringify({
          schemaVersion: 1,
          issueIdentifier: "AG-1",
          repoHead: "abc1234",
          status: "passed",
          commands: [],
          reuseProfile: {
            workflowConfigHash: "hash",
            trustMode: "danger",
            automationProfile: "high-throughput",
            automationRepairPolicy: "mechanical-first",
            riskProfile: "review=enabled"
          }
        }),
        validationPath: ".agent-os/validation/AG-1.json",
        issueIdentifier: "AG-1",
        prHeadSha: "abc1234"
      })
    ).toThrow("supervisor validation evidence commands must be a non-empty array");
  });

  it("requires an explicit tracker tool allowlist before lookup, tracker writes, or fallback", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-allowlist-"));
    const tracker = new MemoryTracker();

    await expect(
      commentWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig({ allowedTrackerTools: [] }), tracker },
        { issue: "AG-1", event: "status_update", tool: "scripts/agent-linear-comment.sh", body: "handoff" }
      )
    ).rejects.toThrow("lifecycle.allowed_tracker_tools is required for agent tracker writes");

    expect(tracker.lookups).toEqual([]);
    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "handoff-AG-1.md"), "utf8")).rejects.toThrow();
  });

  it("rejects unallowed tracker tools before tracker writes or local issue-state writes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-tool-"));
    const handoffPath = join(repo, ".agent-os", "handoff-AG-1.md");
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(handoffPath, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/14\n", "utf8");
    const tracker = new MemoryTracker();

    await expect(
      recordHandoffWithAgentLifecycleTool(
        {
          repoRoot: repo,
          config: lifecycleConfig({ allowedTrackerTools: ["scripts/agent-linear-comment.sh"] }),
          tracker
        },
        { issue: "AG-1", handoffPath, tool: "scripts/agent-linear-handoff.sh" }
      )
    ).rejects.toThrow("lifecycle.allowed_tracker_tools does not include scripts/agent-linear-handoff.sh");

    expect(tracker.lookups).toEqual([]);
    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8")).rejects.toThrow();
  });

  it("rejects invalid marker tokens without writing fallback handoffs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-marker-"));
    const tracker = new MemoryTracker();

    await expect(
      commentWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        { issue: "AG-1", event: "bad event", tool: "scripts/agent-linear-comment.sh", body: "handoff" }
      )
    ).rejects.toThrow("event must contain only letters, numbers, dot, underscore, colon, or hyphen");

    expect(tracker.lookups).toEqual(["AG-1"]);
    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "handoff-AG-1.md"), "utf8")).rejects.toThrow();
  });

  it("strictly gates incomplete agent-owned lifecycle writes before lookup or fallback", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-agent-owned-"));
    const tracker = new MemoryTracker();

    await expect(
      commentWithAgentLifecycleTool(
        {
          repoRoot: repo,
          config: lifecycleConfig({
            mode: "agent-owned",
            idempotencyMarkerFormat: null,
            allowedStateTransitions: [],
            duplicateCommentBehavior: null,
            fallbackBehavior: null,
            maturityAcknowledgement: null
          }),
          tracker
        },
        { issue: "AG-1", event: "status_update", tool: "scripts/agent-linear-comment.sh", body: "handoff" }
      )
    ).rejects.toThrow("lifecycle.mode=agent-owned requires lifecycle.idempotency_marker_format in strict mode");

    expect(tracker.lookups).toEqual([]);
    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "handoff-AG-1.md"), "utf8")).rejects.toThrow();
  });

  it("rejects invalid attach-pr marker tokens before writing local issue state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-pr-marker-"));
    const tracker = new MemoryTracker();

    await expect(
      attachPrWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        {
          issue: "AG-1",
          event: "bad event",
          prUrl: "https://github.com/o/r/pull/12",
          tool: "scripts/agent-linear-pr.sh"
        }
      )
    ).rejects.toThrow("event must contain only letters, numbers, dot, underscore, colon, or hyphen");

    expect(tracker.lookups).toEqual(["AG-1"]);
    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8")).rejects.toThrow();
  });

  it("rejects invalid handoff marker tokens before reading or writing local issue state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-handoff-marker-"));
    const handoffPath = join(repo, ".agent-os", "handoff-AG-1.md");
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(handoffPath, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/13\n", "utf8");
    const tracker = new MemoryTracker();

    await expect(
      recordHandoffWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        { issue: "AG-1", event: "bad event", handoffPath, tool: "scripts/agent-linear-handoff.sh" }
      )
    ).rejects.toThrow("event must contain only letters, numbers, dot, underscore, colon, or hyphen");

    expect(tracker.lookups).toEqual(["AG-1"]);
    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8")).rejects.toThrow();
  });

  it("records PR metadata locally and posts a marker-backed PR update", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-pr-"));
    await initGitRemote(repo);
    const tracker = new MemoryTracker();

    await attachPrWithAgentLifecycleTool(
      { repoRoot: repo, config: lifecycleConfig(), tracker },
      {
        issue: "AG-1",
        prUrl: "https://github.com/o/r/pull/12",
        tool: "scripts/agent-linear-pr.sh"
      }
    );

    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.prUrl).toBe("https://github.com/o/r/pull/12");
    expect(tracker.comments[0]).toMatchObject({
      marker: "<!-- agentos:event=pr_metadata issue=AG-1 -->"
    });
  });

  it("correlates agent-owned PR metadata and handoff comments with run and attempt", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-pr-handoff-correlation-"));
    await initGitRemote(repo);
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    const handoffPath = join(repo, ".agent-os", "handoff-AG-1.md");
    const tracker = new MemoryTracker();
    const config = lifecycleConfig({
      mode: "agent-owned",
      idempotencyMarkerFormat: "<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->"
    });
    await writeLifecycleValidationEvidence(repo, config, "AG-1", { runId: "run-123" });
    await writeFile(
      handoffPath,
      "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/12\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
      "utf8"
    );

    const pr = await attachPrWithAgentLifecycleTool(
      { repoRoot: repo, config, tracker },
      {
        issue: "AG-1",
        prUrl: "https://github.com/o/r/pull/12",
        tool: "scripts/agent-linear-pr.sh",
        runId: "run-123",
        attempt: 1
      }
    );
    const handoff = await recordHandoffWithAgentLifecycleTool(
      { repoRoot: repo, config, tracker },
      { issue: "AG-1", handoffPath, tool: "scripts/agent-linear-handoff.sh", runId: "run-123", attempt: 1 }
    );

    expect(pr).toMatchObject({
      marker: "<!-- agentos:event=pr_metadata issue=AG-1 run=run-123 attempt=1 -->",
      runId: "run-123",
      attempt: 1
    });
    expect(handoff).toMatchObject({
      marker: "<!-- agentos:event=run_handoff issue=AG-1 run=run-123 attempt=1 -->",
      runId: "run-123",
      attempt: 1
    });
    expect(tracker.comments.map((comment) => comment.marker)).toEqual([
      "<!-- agentos:event=pr_metadata issue=AG-1 run=run-123 attempt=1 -->",
      "<!-- agentos:event=run_handoff issue=AG-1 run=run-123 attempt=1 -->"
    ]);
  });

  it("rejects handoffs with invalid validation evidence before tracker writes or issue-state persistence", async () => {
    const cases: Array<{
      name: string;
      handoff: string;
      expectedError: string;
      config?: ServiceConfig;
      input?: Partial<Parameters<typeof recordHandoffWithAgentLifecycleTool>[1]>;
      prepare?: (repo: string, config: ServiceConfig) => Promise<void>;
    }> = [
      {
        name: "missing-marker",
        handoff: "AgentOS-Outcome: implemented\n",
        expectedError: "handoff missing Validation-JSON marker"
      },
      {
        name: "missing-file",
        handoff: "AgentOS-Outcome: implemented\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
        expectedError: "validation evidence file does not exist"
      },
      {
        name: "invalid-json",
        handoff: "AgentOS-Outcome: implemented\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
        expectedError: "validation evidence is not valid JSON",
        prepare: async (repo) => {
          await mkdir(join(repo, ".agent-os", "validation"), { recursive: true });
          await writeFile(join(repo, ".agent-os", "validation", "AG-1.json"), "{not json", "utf8");
        }
      },
      {
        name: "issue-mismatch",
        handoff: "AgentOS-Outcome: implemented\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
        expectedError: "issueIdentifier mismatch: expected AG-1",
        prepare: async (repo, config) => {
          await writeLifecycleValidationEvidence(repo, config, "AG-1", { issueIdentifier: "AG-2" });
        }
      },
      {
        name: "failed-status",
        handoff: "AgentOS-Outcome: implemented\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
        expectedError: "final validation status is not passed",
        prepare: async (repo, config) => {
          await writeLifecycleValidationEvidence(repo, config, "AG-1", { status: "failed" });
        }
      },
      {
        name: "run-mismatch",
        handoff: "AgentOS-Outcome: implemented\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
        expectedError: "runId mismatch: expected run-123",
        config: lifecycleConfig({
          mode: "agent-owned",
          idempotencyMarkerFormat: "<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->"
        }),
        input: { runId: "run-123", attempt: 0 },
        prepare: async (repo, config) => {
          await writeLifecycleValidationEvidence(repo, config, "AG-1", { runId: "other-run" });
        }
      },
      {
        name: "missing-required-command",
        handoff: "AgentOS-Outcome: implemented\n\nValidation-JSON: .agent-os/validation/AG-1.json\n",
        expectedError: "missing passing command evidence: npm run agent-check",
        prepare: async (repo, config) => {
          await writeLifecycleValidationEvidence(repo, config, "AG-1", { commands: [validationCommand("npm test")] });
        }
      }
    ];

    for (const item of cases) {
      const repo = await mkdtemp(join(tmpdir(), `agent-os-agent-lifecycle-handoff-evidence-${item.name}-`));
      const handoffPath = join(repo, ".agent-os", "handoff-AG-1.md");
      await mkdir(join(repo, ".agent-os"), { recursive: true });
      await writeFile(handoffPath, item.handoff, "utf8");
      const tracker = new MemoryTracker();
      const config = item.config ?? lifecycleConfig();
      await item.prepare?.(repo, config);

      await expect(
        recordHandoffWithAgentLifecycleTool(
          { repoRoot: repo, config, tracker },
          { issue: "AG-1", handoffPath, tool: "scripts/agent-linear-handoff.sh", ...item.input }
        )
      ).rejects.toThrow(item.expectedError);

      expect(tracker.comments).toEqual([]);
      await expect(readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8")).rejects.toThrow();
    }
  });

  it("rejects malformed or off-repository PR metadata before writing local issue state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-pr-repo-"));
    await initGitRemote(repo);
    const tracker = new MemoryTracker();

    await expect(
      attachPrWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        {
          issue: "AG-1",
          prUrl: "https://example.com/o/r/pull/12",
          tool: "scripts/agent-linear-pr.sh"
        }
      )
    ).rejects.toThrow("invalid_github_pull_request_url");

    await expect(
      attachPrWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        {
          issue: "AG-1",
          prUrl: "https://github.com/other/r/pull/12",
          tool: "scripts/agent-linear-pr.sh"
        }
      )
    ).rejects.toThrow("pull request URL must belong to current repository o/r");

    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8")).rejects.toThrow();
  });

  it("keeps marker-backed PR metadata comments complete across multiple PRs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-pr-multi-"));
    await initGitRemote(repo);
    const tracker = new MemoryTracker();

    await attachPrWithAgentLifecycleTool(
      { repoRoot: repo, config: lifecycleConfig(), tracker },
      {
        issue: "AG-1",
        prUrl: "https://github.com/o/r/pull/12",
        tool: "scripts/agent-linear-pr.sh"
      }
    );
    await attachPrWithAgentLifecycleTool(
      { repoRoot: repo, config: lifecycleConfig(), tracker },
      {
        issue: "AG-1",
        prUrl: "https://github.com/o/r/pull/13",
        tool: "scripts/agent-linear-pr.sh"
      }
    );

    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.prs.map((pr: { url: string }) => pr.url)).toEqual([
      "https://github.com/o/r/pull/12",
      "https://github.com/o/r/pull/13"
    ]);
    expect(tracker.comments.at(-1)?.body).toContain("https://github.com/o/r/pull/12");
    expect(tracker.comments.at(-1)?.body).toContain("https://github.com/o/r/pull/13");
  });

  it("records handoff PR metadata locally and posts the redacted handoff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-handoff-"));
    await initGitRemote(repo);
    const handoffPath = join(repo, ".agent-os", "handoff-AG-1.md");
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    const token = linearToken();
    const config = lifecycleConfig();
    await writeLifecycleValidationEvidence(repo, config, "AG-1");
    await writeFile(
      handoffPath,
      [
        "AgentOS-Outcome: implemented",
        "",
        `Summary with token ${token}`,
        "",
        "PR: https://github.com/o/r/pull/13",
        "",
        "Validation-JSON: .agent-os/validation/AG-1.json"
      ].join("\n"),
      "utf8"
    );
    const tracker = new MemoryTracker();

    await recordHandoffWithAgentLifecycleTool(
      { repoRoot: repo, config, tracker },
      { issue: "AG-1", handoffPath, tool: "scripts/agent-linear-handoff.sh" }
    );

    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.outcome).toBe("implemented");
    expect(state.prUrl).toBe("https://github.com/o/r/pull/13");
    expect(tracker.comments[0].body).toContain("Summary with token [REDACTED]");
  });

  it("rejects off-repository PR URLs in handoffs before writing local issue state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-handoff-pr-"));
    await initGitRemote(repo);
    const handoffPath = join(repo, ".agent-os", "handoff-AG-1.md");
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(handoffPath, "AgentOS-Outcome: implemented\n\nPR: https://github.com/other/r/pull/13\n", "utf8");
    const tracker = new MemoryTracker();

    await expect(
      recordHandoffWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        { issue: "AG-1", handoffPath, tool: "scripts/agent-linear-handoff.sh" }
      )
    ).rejects.toThrow("pull request URL must belong to current repository o/r");

    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8")).rejects.toThrow();
  });

  it("only records handoffs from the resolved issue handoff path", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-lifecycle-handoff-path-"));
    const handoffPath = join(repo, ".agent-os", "handoff-issue-1.md");
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(handoffPath, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/15\n", "utf8");
    const tracker = new MemoryTracker();

    await expect(
      recordHandoffWithAgentLifecycleTool(
        { repoRoot: repo, config: lifecycleConfig(), tracker },
        { issue: "issue-1", handoffPath, tool: "scripts/agent-linear-handoff.sh" }
      )
    ).rejects.toThrow("handoff file must be .agent-os/handoff-AG-1.md");

    expect(tracker.comments).toEqual([]);
    await expect(readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8")).rejects.toThrow();
  });
});

class MemoryTracker implements AgentLifecycleTracker {
  comments: Array<{ issue: string; body: string; marker: string; duplicateBehavior?: string }> = [];
  moves: Array<{ issue: string; state: string }> = [];
  lookups: string[] = [];
  failComment: Error | null = null;
  notFound = new Set<string>();

  constructor(private readonly issue: Partial<LinearIssueReference> = {}) {}

  async findIssueReference(issueIdentifierOrId: string): Promise<LinearIssueReference> {
    this.lookups.push(issueIdentifierOrId);
    if (this.notFound.has(issueIdentifierOrId)) throw new Error(`Linear issue not found: ${issueIdentifierOrId}`);
    return {
      id: "issue-1",
      identifier: "AG-1",
      state: "Todo",
      team: { id: "team-1", key: "AG", name: "AgentOS" },
      ...this.issue
    };
  }

  async upsertCommentWithMarker(
    issue: string,
    body: string,
    marker: string,
    duplicateBehavior?: string
  ): Promise<LinearCommentWriteResult> {
    if (this.failComment) throw this.failComment;
    this.comments.push({ issue, body, marker, duplicateBehavior });
    return "created";
  }

  async move(issue: string, state: string): Promise<void> {
    this.moves.push({ issue, state });
  }
}

function lifecycleConfig(overrides: Partial<ServiceConfig["lifecycle"]> = {}): ServiceConfig {
  return {
    trustMode: "ci-locked",
    automation: { profile: "conservative", repairPolicy: "conservative" },
    lifecycle: {
      mode: "hybrid",
      allowedTrackerTools: [
        "scripts/agent-linear-comment.sh",
        "scripts/agent-linear-move.sh",
        "scripts/agent-linear-pr.sh",
        "scripts/agent-linear-handoff.sh"
      ],
      clientTrackerTools: [],
      idempotencyMarkerFormat: "<!-- agentos:event={event} issue={issue} -->",
      allowedStateTransitions: ["Todo -> In Progress", "In Progress -> Human Review"],
      duplicateCommentBehavior: "upsert",
      fallbackBehavior: "write handoff and stop human_required",
      maturityAcknowledgement: null,
      trustedDecisionActors: [],
      ...overrides
    },
    tracker: {
      kind: "linear",
      endpoint: "https://linear.test/graphql",
      apiKey: "lin_test",
      projectSlug: "AgentOS",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done", "Closed", "Canceled", "Duplicate"],
      runningState: "In Progress",
      reviewState: "Human Review",
      mergeState: "Merging",
      needsInputState: "Human Review"
    },
    polling: { intervalMs: 1000 },
    workspace: { root: ".agent-os/workspaces" },
    hooks: { afterCreate: null, beforeRun: null, afterRun: null, beforeRemove: null, timeoutMs: 1000 },
    agent: {
      maxConcurrentAgents: 1,
      maxTurns: 1,
      maxRetryAttempts: 1,
      maxRetryBackoffMs: 1,
      maxConcurrentAgentsByState: new Map()
    },
    contextBudget: { enabled: true, maxPromptTokens: 200_000, maxCumulativeTokens: 1_000_000, largeSectionTokens: 8_000 },
    validationBudget: { enabled: true, fullValidationCommand: "npm run agent-check", maxFullValidationRunsPerHead: 1 },
    codex: {
      command: "node tests/fixtures/fake-app-server.mjs",
      approvalEventPolicy: "deny",
      userInputPolicy: "deny",
      turnTimeoutMs: 1000,
      readTimeoutMs: 1000,
      stallTimeoutMs: 1000,
      passThrough: {}
    },
    github: {
      command: "gh",
      mergeMode: "manual",
      mergeMethod: "squash",
      requireChecks: true,
      deleteBranch: true,
      doneState: "Done",
      allowHumanMergeOverride: false,
      baseBranch: "main"
    },
    daemon: { mainBranchRefreshIntervalTicks: 5 },
    review: {
      enabled: false,
      maxIterations: 1,
      requiredReviewers: ["self", "correctness", "tests", "architecture"],
      optionalReviewers: ["security"],
      requireAllBlockingResolved: true,
      blockingSeverities: ["P0", "P1", "P2"],
      parallelReviewers: false,
      maxConcurrentReviewers: 1,
      skipOptionalReviewersAfterBlockingRequired: false,
      budget: {
        enabled: true,
        mode: "recommend-only",
        maxReviewElapsedMs: 30 * 60 * 1000,
        maxReviewIterations: 1,
        maxFixerIterations: 0,
        maxBlockingFindings: 10,
        maxP1P2Findings: 5,
        maxChangedFiles: 40,
        maxValidationReruns: 2,
        maxReviewTokens: 200_000,
        repeatedBroadCategoryThreshold: 2,
        lateNewBlockingFindingAfterApproval: true,
        broadCategories: ["architecture", "lifecycle", "orchestration", "status", "workflow"]
      }
    }
  };
}

function validationCommand(name = "npm run agent-check"): ValidationEvidence["commands"][number] {
  const now = new Date().toISOString();
  return { name, exitCode: 0, startedAt: now, finishedAt: now };
}

async function writeLifecycleValidationEvidence(
  repo: string,
  config: ServiceConfig,
  issueIdentifier: string,
  overrides: Partial<ValidationEvidence> = {}
): Promise<void> {
  await writeValidationEvidence(join(repo, ".agent-os", "validation", `${issueIdentifier}.json`), {
    schemaVersion: 1,
    issueIdentifier,
    runId: "run-123",
    status: "passed",
    commands: [validationCommand(config.validationBudget.fullValidationCommand)],
    reuseProfile: validationReuseProfileForConfig(config),
    ...overrides
  });
}

function linearToken(): string {
  return `lin_${"a".repeat(26)}`;
}

async function initGitRemote(repo: string): Promise<void> {
  await execGit(repo, ["init"]);
  await execGit(repo, ["remote", "add", "origin", "https://github.com/o/r.git"]);
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("git", args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}
