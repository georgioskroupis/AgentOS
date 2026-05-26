import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commentWithAgentLifecycleTool, moveWithAgentLifecycleTool, recordHandoffWithAgentLifecycleTool, agentTrackerMarker } from "../src/agent-lifecycle.js";
import type { AgentLifecycleTracker } from "../src/agent-lifecycle.js";
import { verifyAgentOwnedLifecycleEvidence } from "../src/agent-owned-lifecycle-evidence.js";
import { IssueStateStore } from "../src/issue-state.js";
import { JsonlLogger } from "../src/logging.js";
import { Orchestrator } from "../src/orchestrator.js";
import { RunArtifactStore } from "../src/runs.js";
import type { AgentRunResult, AgentRunner, Issue, IssueComment, IssueTracker, ServiceConfig, ValidationState } from "../src/types.js";
import { writeValidationEvidence } from "../src/validation.js";
import { loadWorkflow, resolveServiceConfig } from "../src/workflow.js";

const readyIssue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Ready issue",
  description: null,
  priority: 1,
  state: "Ready",
  branch_name: null,
  url: null,
  assignee: null,
  labels: [],
  blocked_by: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
};

describe("agent-owned lifecycle evidence", () => {
  it("detects state moves without a start marker", async () => {
    const { config, workspacePath, validation } = await evidenceFixture();
    const handoff = "AgentOS-Outcome: already-satisfied\nValidation-JSON: .agent-os/validation/AG-1.json";
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [comment("c-handoff", agentTrackerMarker(config, "run_handoff", "AG-1", { runId: "run-1", attempt: 0 }))],
      handoff,
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: { schemaVersion: 1, issueId: "issue-1", issueIdentifier: "AG-1", outcome: "already_satisfied", validation, updatedAt: "2026-01-01T00:00:00.000Z" },
      validation
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.missing).toContain("marker:run_started");
  });

  it("detects a start marker with the wrong observed state", async () => {
    const { config, workspacePath, validation } = await evidenceFixture();
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "In Progress",
      comments: [
        comment("c-start", agentTrackerMarker(config, "run_started", "AG-1", { runId: "run-1", attempt: 0 })),
        comment("c-handoff", agentTrackerMarker(config, "run_handoff", "AG-1", { runId: "run-1", attempt: 0 }))
      ],
      handoff: "AgentOS-Outcome: already-satisfied\nValidation-JSON: .agent-os/validation/AG-1.json",
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: { schemaVersion: 1, issueId: "issue-1", issueIdentifier: "AG-1", outcome: "already_satisfied", validation, updatedAt: "2026-01-01T00:00:00.000Z" },
      validation
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.missing).toContain("state:Human Review");
  });

  it("detects PR metadata without a handoff", async () => {
    const { config, workspacePath, validation } = await evidenceFixture();
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [
        comment("c-start", agentTrackerMarker(config, "run_started", "AG-1", { runId: "run-1", attempt: 0 })),
        comment("c-pr", agentTrackerMarker(config, "pr_metadata", "AG-1", { runId: "run-1", attempt: 0 }))
      ],
      handoff: null,
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: {
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        prs: [{ url: "https://github.com/o/r/pull/1", discoveredAt: "2026-01-01T00:00:00.000Z", source: "handoff" }],
        validation,
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      validation
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.missing).toEqual(expect.arrayContaining(["handoff", "marker:run_handoff"]));
    expect(evidence.prUrls).toEqual(["https://github.com/o/r/pull/1"]);
  });

  it("detects handoff evidence without validation evidence", async () => {
    const { config, workspacePath } = await evidenceFixture();
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [
        comment("c-start", agentTrackerMarker(config, "run_started", "AG-1", { runId: "run-1", attempt: 0 })),
        comment("c-handoff", agentTrackerMarker(config, "run_handoff", "AG-1", { runId: "run-1", attempt: 0 }))
      ],
      handoff: "AgentOS-Outcome: already-satisfied",
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: { schemaVersion: 1, issueId: "issue-1", issueIdentifier: "AG-1", outcome: "already_satisfied", updatedAt: "2026-01-01T00:00:00.000Z" },
      validation: null
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.missing).toEqual(expect.arrayContaining(["validation_evidence", "validation_evidence_passed"]));
  });

  it("detects Human Review state without a handoff", async () => {
    const { config, workspacePath } = await evidenceFixture();
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [comment("c-start", agentTrackerMarker(config, "run_started", "AG-1", { runId: "run-1", attempt: 0 }))],
      handoff: null,
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: null,
      validation: null
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.missing).toEqual(expect.arrayContaining(["handoff", "marker:run_handoff", "validation_evidence"]));
  });

  it("detects duplicate, stale, wrong issue, wrong run, and wrong author markers", async () => {
    const { config, workspacePath, validation } = await evidenceFixture();
    const start = agentTrackerMarker(config, "run_started", "AG-1", { runId: "run-1", attempt: 0 });
    const stale = agentTrackerMarker(config, "run_handoff", "AG-1", { runId: "old-run", attempt: 0 });
    const wrongIssue = agentTrackerMarker(config, "run_started", "AG-2", { runId: "run-1", attempt: 0 });
    const wrongRun = agentTrackerMarker(config, "run_started", "AG-1", { runId: "wrong-run", attempt: 0 });
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [
        comment("c-start-1", start, { authorEmail: "somebody@example.com", updatedAt: "2026-01-01T00:00:02.000Z" }),
        comment("c-start-2", start, { authorEmail: "somebody@example.com", updatedAt: "2026-01-01T00:00:02.000Z" }),
        comment("c-stale", stale, { authorEmail: "agent@example.com", updatedAt: "2026-01-01T00:00:00.000Z" }),
        comment("c-wrong-issue", wrongIssue, { authorEmail: "agent@example.com" }),
        comment("c-wrong-run", wrongRun, { authorEmail: "agent@example.com", updatedAt: "2026-01-01T00:00:03.000Z" })
      ],
      handoff: "AgentOS-Outcome: already-satisfied\nValidation-JSON: .agent-os/validation/AG-1.json",
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: { schemaVersion: 1, issueId: "issue-1", issueIdentifier: "AG-1", outcome: "already_satisfied", validation, updatedAt: "2026-01-01T00:00:00.000Z" },
      validation,
      expectedAuthors: ["agent@example.com"]
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.duplicateMarkers.map((finding) => finding.event)).toContain("run_started");
    expect(evidence.staleEvidence.map((finding) => finding.commentIds[0])).toContain("c-stale");
    expect(evidence.wrongIssue.map((finding) => finding.commentIds[0])).toContain("c-wrong-issue");
    expect(evidence.wrongRun.map((finding) => finding.commentIds[0])).toContain("c-wrong-run");
    expect(evidence.wrongAuthor.map((finding) => finding.commentIds[0])).toContain("c-start-1");
  });

  it("fails stale old markers when the current exact marker is missing", async () => {
    const { config, workspacePath, validation } = await evidenceFixture();
    const stale = agentTrackerMarker(config, "run_started", "AG-1", { runId: "old-run", attempt: 0 });
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [
        comment("c-stale", stale, { updatedAt: "2026-01-01T00:00:00.000Z" }),
        comment("c-handoff", agentTrackerMarker(config, "run_handoff", "AG-1", { runId: "run-1", attempt: 0 }))
      ],
      handoff: "AgentOS-Outcome: already-satisfied\nValidation-JSON: .agent-os/validation/AG-1.json",
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: { schemaVersion: 1, issueId: "issue-1", issueIdentifier: "AG-1", outcome: "already_satisfied", validation, updatedAt: "2026-01-01T00:00:00.000Z" },
      validation
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.missing).toContain("marker:run_started");
    expect(evidence.staleEvidence.map((finding) => finding.commentIds[0])).toContain("c-stale");
  });

  it("keeps stale old markers diagnostic when the current exact marker exists", async () => {
    const { config, workspacePath, validation } = await evidenceFixture();
    const stale = agentTrackerMarker(config, "run_started", "AG-1", { runId: "old-run", attempt: 0 });
    const current = agentTrackerMarker(config, "run_started", "AG-1", { runId: "run-1", attempt: 0 });
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [
        comment("c-stale", stale, { updatedAt: "2026-01-01T00:00:00.000Z" }),
        comment("c-current", current, { updatedAt: "2026-01-01T00:00:01.000Z" }),
        comment("c-handoff", agentTrackerMarker(config, "run_handoff", "AG-1", { runId: "run-1", attempt: 0 }))
      ],
      handoff: "AgentOS-Outcome: already-satisfied\nValidation-JSON: .agent-os/validation/AG-1.json",
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: { schemaVersion: 1, issueId: "issue-1", issueIdentifier: "AG-1", outcome: "already_satisfied", validation, updatedAt: "2026-01-01T00:00:00.000Z" },
      validation
    });

    expect(evidence.status).toBe("passed");
    expect(evidence.staleEvidence.map((finding) => finding.commentIds[0])).toContain("c-stale");
    expect(evidence.wrongRun).toEqual([]);
  });

  it("fails duplicate current exact markers", async () => {
    const { config, workspacePath, validation } = await evidenceFixture();
    const current = agentTrackerMarker(config, "run_started", "AG-1", { runId: "run-1", attempt: 0 });
    const evidence = verifyAgentOwnedLifecycleEvidence({
      config,
      issueIdentifier: "AG-1",
      runId: "run-1",
      attempt: 0,
      expectedState: "Human Review",
      observedState: "Human Review",
      comments: [
        comment("c-current-1", current),
        comment("c-current-2", current),
        comment("c-handoff", agentTrackerMarker(config, "run_handoff", "AG-1", { runId: "run-1", attempt: 0 }))
      ],
      handoff: "AgentOS-Outcome: already-satisfied\nValidation-JSON: .agent-os/validation/AG-1.json",
      handoffPath: join(workspacePath, ".agent-os", "handoff-AG-1.md"),
      workspacePath,
      state: { schemaVersion: 1, issueId: "issue-1", issueIdentifier: "AG-1", outcome: "already_satisfied", validation, updatedAt: "2026-01-01T00:00:00.000Z" },
      validation
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.duplicateMarkers.map((finding) => finding.event)).toContain("run_started");
  });

  it("records passed agent-owned evidence before completing the run", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-owned-evidence-pass-"));
    const workflowPath = await writeAgentOwnedWorkflow(repo);
    const tracker = new AgentOwnedMemoryTracker(readyIssue);
    const runner = agentOwnedRunner({ tracker, includeStartMarker: true });

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.phase).toBe("completed");
    expect(state?.agentOwnedLifecycleEvidence).toMatchObject({ status: "passed", issueIdentifier: "AG-1" });
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.status).toBe("succeeded");
    expect(summary.artifactHashes).toHaveProperty("agent-owned-lifecycle-evidence.json");
    const evidence = JSON.parse(await readFile(join(repo, ".agent-os", "runs", summary.runId, "agent-owned-lifecycle-evidence.json"), "utf8"));
    expect(evidence.status).toBe("passed");
    expect(tracker.schedulerComments).toEqual([]);
    expect(tracker.moveCalls).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);

    const second = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("restart should not redispatch the completed Human Review issue");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);
    expect(second.dispatched).toBe(0);
    expect(tracker.schedulerComments).toEqual([]);
    expect(tracker.moveCalls).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
  });

  it("marks missing agent-owned evidence human-required without duplicating lifecycle writes and remains stable after restart", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-owned-evidence-fail-"));
    const workflowPath = await writeAgentOwnedWorkflow(repo);
    const tracker = new AgentOwnedMemoryTracker(readyIssue);
    const runner = agentOwnedRunner({ tracker, includeStartMarker: false });
    const logger = new JsonlLogger(repo);

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state).toMatchObject({
      phase: "human-required",
      reviewStatus: "human_required",
      lifecycleStatus: "agent_owned_lifecycle_missing_evidence"
    });
    expect(state?.agentOwnedLifecycleEvidence?.missing).toContain("marker:run_started");
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.status).toBe("failed");
    expect(summary.error).toContain("agent_owned_lifecycle_missing_evidence");
    expect(tracker.schedulerComments).toEqual([]);
    expect(tracker.moveCalls).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect((await logger.tail(100)).filter((entry) => entry.type === "scheduler_safety")).toEqual([
      expect.objectContaining({
        message: "run_started_state_sync:move:applied",
        payload: expect.objectContaining({ requestedState: "In Progress" })
      })
    ]);
  });

  it("keeps start-only partial evidence human-required and stable after restart", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-owned-evidence-start-only-"));
    const workflowPath = await writeAgentOwnedWorkflow(repo);
    const tracker = new AgentOwnedMemoryTracker(readyIssue);
    const runner = agentOwnedRunner({ tracker, includeStartMarker: true, includeHandoffMarker: false });

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    await expectMissingEvidenceAfterRestart({ repo, workflowPath, tracker, expectedMissing: ["marker:run_handoff"] });
  });

  it("keeps start-and-pr partial evidence human-required and stable after restart", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-owned-evidence-pr-only-"));
    const workflowPath = await writeAgentOwnedWorkflow(repo);
    const tracker = new AgentOwnedMemoryTracker(readyIssue);
    const runner = agentOwnedRunner({
      tracker,
      includeStartMarker: true,
      includePrMetadataMarker: true,
      includeHandoffMarker: false
    });

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(tracker.comments.some((entry) => entry.body.includes("agentos:event=pr_metadata"))).toBe(true);
    await expectMissingEvidenceAfterRestart({ repo, workflowPath, tracker, expectedMissing: ["marker:run_handoff"] });
  });

  it("keeps start-and-handoff partial evidence human-required when validation evidence is missing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-agent-owned-evidence-validation-missing-"));
    const workflowPath = await writeAgentOwnedWorkflow(repo);
    const tracker = new AgentOwnedMemoryTracker(readyIssue);
    const runner = agentOwnedRunner({
      tracker,
      includeStartMarker: true,
      includeHandoffMarker: true,
      includeValidationEvidence: false
    });

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    await expectMissingEvidenceAfterRestart({ repo, workflowPath, tracker, expectedMissing: ["validation_evidence", "validation_evidence_passed"] });
  });
});

async function evidenceFixture(): Promise<{ config: ServiceConfig; workspacePath: string; validation: ValidationState }> {
  const repo = await mkdtemp(join(tmpdir(), "agent-os-evidence-fixture-"));
  const workflowPath = await writeAgentOwnedWorkflow(repo);
  const workflow = await loadWorkflow(workflowPath);
  const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test" });
  const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
  const validation: ValidationState = {
    status: "passed",
    path: ".agent-os/validation/AG-1.json",
    runId: "run-1",
    finalStatus: "passed",
    checkedAt: "2026-01-01T00:00:00.000Z",
    acceptedCommands: [{ name: "npm run agent-check", exitCode: 0 }]
  };
  await mkdir(join(workspacePath, ".agent-os", "validation"), { recursive: true });
  await writeValidationEvidence(join(workspacePath, validation.path), {
    schemaVersion: 1,
    issueIdentifier: "AG-1",
    runId: "run-1",
    status: "passed",
    finalResult: {
      status: "passed",
      command: "npm run agent-check",
      exitCode: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z"
    },
    commands: [
      {
        name: "npm run agent-check",
        exitCode: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  });
  return { config, workspacePath, validation };
}

async function writeAgentOwnedWorkflow(repo: string): Promise<string> {
  const workflowPath = join(repo, "WORKFLOW.md");
  await writeFile(
    workflowPath,
    [
      "---",
      "lifecycle:",
      "  mode: agent-owned",
      "  allowed_tracker_tools:",
      "    - scripts/agent-linear-comment.sh",
      "    - scripts/agent-linear-move.sh",
      "    - scripts/agent-linear-pr.sh",
      "    - scripts/agent-linear-handoff.sh",
      "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
      "  allowed_state_transitions:",
      "    - Ready -> In Progress",
      "    - Ready -> Human Review",
      "    - In Progress -> Human Review",
      "  duplicate_comment_behavior: upsert",
      "  fallback_behavior: write handoff and stop human_required",
      "tracker:",
      "  kind: linear",
      "  api_key: $LINEAR_API_KEY",
      "  project_slug: AgentOS",
      "  active_states: [Ready]",
      "  running_state: In Progress",
      "  review_state: Human Review",
      "workspace:",
      "  root: .agent-os/workspaces",
      "agent:",
      "  max_turns: 1",
      "review:",
      "  enabled: false",
      "---",
      "Do {{ issue.identifier }}"
    ].join("\n"),
    "utf8"
  );
  return workflowPath;
}

function agentOwnedRunner(input: {
  tracker: AgentOwnedMemoryTracker;
  includeStartMarker: boolean;
  includePrMetadataMarker?: boolean;
  includeHandoffMarker?: boolean;
  includeValidationEvidence?: boolean;
  includePrInHandoff?: boolean;
}): AgentRunner {
  return {
    async run(runInput): Promise<AgentRunResult> {
      const runId = runInput.prompt.match(/^Run ID: (.+)$/m)?.[1] ?? "missing-run-id";
      const attempt = runInput.attempt ?? 0;
      if (input.includeStartMarker) {
        await commentWithAgentLifecycleTool(
          { repoRoot: runInput.workspace.path, config: runInput.config, tracker: input.tracker },
          {
            issue: "AG-1",
            event: "run_started",
            tool: "scripts/agent-linear-comment.sh",
            body: "AgentOS started",
            runId,
            attempt
          }
        );
      }
      if (input.includePrMetadataMarker) {
        await input.tracker.addAgentMarker("pr_metadata", runInput.config, runId, attempt, "PR: https://github.com/o/r/pull/1");
      }
      const handoffBody = ["AgentOS-Outcome: already-satisfied", input.includePrInHandoff ? "PR: https://github.com/o/r/pull/1" : ""].filter(Boolean).join("\n\n");
      if (input.includeValidationEvidence ?? true) {
        await writePassingHandoff(runInput.workspace.path, "AG-1", runInput.prompt, handoffBody);
      } else {
        await writeHandoffWithoutValidation(runInput.workspace.path, "AG-1", handoffBody);
      }
      if (input.includeHandoffMarker ?? true) {
        if (input.includeValidationEvidence ?? true) {
          await recordHandoffWithAgentLifecycleTool(
            { repoRoot: runInput.workspace.path, config: runInput.config, tracker: input.tracker },
            {
              issue: "AG-1",
              handoffPath: join(runInput.workspace.path, ".agent-os", "handoff-AG-1.md"),
              tool: "scripts/agent-linear-handoff.sh",
              runId,
              attempt
            }
          );
        } else {
          await input.tracker.addAgentMarker("run_handoff", runInput.config, runId, attempt, handoffBody);
        }
      }
      await moveWithAgentLifecycleTool(
        { repoRoot: runInput.workspace.path, config: runInput.config, tracker: input.tracker },
        {
          issue: "AG-1",
          state: "Human Review",
          tool: "scripts/agent-linear-move.sh",
          runId,
          attempt
        }
      );
      return { status: "succeeded" };
    }
  };
}

class AgentOwnedMemoryTracker implements IssueTracker, AgentLifecycleTracker {
  comments: IssueComment[] = [];
  schedulerComments: string[] = [];
  moveCalls: string[] = [];
  private commentCount = 0;

  constructor(private issue: Issue) {}

  async fetchCandidates(): Promise<Issue[]> {
    return [this.issue];
  }

  async fetchIssueStates(): Promise<Map<string, Issue>> {
    return new Map([[this.issue.id, this.issue]]);
  }

  async fetchIssueComments(): Promise<IssueComment[]> {
    return this.comments;
  }

  async comment(_issueIdentifierOrId: string, body: string): Promise<void> {
    this.schedulerComments.push(body);
  }

  async move(issueIdentifierOrId: string, stateName: string): Promise<void> {
    this.moveCalls.push(`${issueIdentifierOrId} -> ${stateName}`);
    if (issueIdentifierOrId !== this.issue.identifier) {
      return;
    }
    this.issue = { ...this.issue, state: stateName, updated_at: new Date().toISOString() };
  }

  async findIssueReference(): Promise<{ id: string; identifier: string; state: string; team: { id: string; key: string; name: string } }> {
    return {
      id: this.issue.id,
      identifier: this.issue.identifier,
      state: this.issue.state,
      team: { id: "team-1", key: "AG", name: "AgentOS" }
    };
  }

  async addAgentMarker(event: string, config: ServiceConfig, runId: string, attempt: number | null, body: string): Promise<void> {
    const marker = agentTrackerMarker(config, event, this.issue.identifier, { runId, attempt });
    await this.upsertCommentWithMarker(this.issue.identifier, body, marker);
  }

  async upsertCommentWithMarker(_issueIdentifier: string, body: string, marker: string): Promise<"created" | "updated" | "skipped"> {
    const existing = this.comments.findIndex((entry) => entry.body.includes(marker));
    const entry: IssueComment = {
      id: existing === -1 ? `comment-${++this.commentCount}` : this.comments[existing].id,
      author: "AgentOS Bot",
      authorId: "agent-os",
      authorEmail: "agent@example.com",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
      body: body.includes(marker) ? body : `${marker}\n${body}`
    };
    if (existing === -1) {
      this.comments.push(entry);
      return "created";
    }
    this.comments[existing] = entry;
    return "updated";
  }
}

function comment(id: string, marker: string, author: Partial<IssueComment> = {}): IssueComment {
  return {
    id,
    body: `${marker}\nbody`,
    author: "AgentOS Bot",
    authorId: "agent-os",
    authorEmail: "agent@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...author
  };
}

async function expectMissingEvidenceAfterRestart(input: { repo: string; workflowPath: string; tracker: AgentOwnedMemoryTracker; expectedMissing: string[] }): Promise<void> {
  const state = await new IssueStateStore(input.repo).read("AG-1");
  expect(state).toMatchObject({
    phase: "human-required",
    reviewStatus: "human_required",
    lifecycleStatus: "agent_owned_lifecycle_missing_evidence"
  });
  expect(state?.agentOwnedLifecycleEvidence?.missing).toEqual(expect.arrayContaining(input.expectedMissing));
  const [summary] = await new RunArtifactStore(input.repo).listRuns();
  expect(summary.status).toBe("failed");
  expect(summary.error).toContain("agent_owned_lifecycle_missing_evidence");
  expect(input.tracker.schedulerComments).toEqual([]);
  expect(input.tracker.moveCalls).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);

  const second = await new Orchestrator({
    repoRoot: input.repo,
    workflowPath: input.workflowPath,
    tracker: input.tracker,
    runner: {
      async run(): Promise<AgentRunResult> {
        throw new Error("restart should not redispatch the Human Review issue");
      }
    },
    logger: new JsonlLogger(input.repo),
    env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
  }).runOnce(true);
  expect(second.dispatched).toBe(0);
  expect(input.tracker.schedulerComments).toEqual([]);
  expect(input.tracker.moveCalls).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
}

async function writePassingHandoff(workspacePath: string, issueIdentifier: string, prompt: string, body: string): Promise<void> {
  const runId = prompt.match(/^Run ID: (.+)$/m)?.[1] ?? "missing-run-id";
  const reuseProfile = prompt.match(/^Validation reuse profile JSON: (.+)$/m)?.[1];
  const validationPath = `.agent-os/validation/${issueIdentifier}.json`;
  await mkdir(join(workspacePath, ".agent-os", "validation"), { recursive: true });
  await writeFile(join(workspacePath, ".agent-os", `handoff-${issueIdentifier}.md`), `${body}\n\nValidation-JSON: ${validationPath}`, "utf8");
  const now = new Date().toISOString();
  await writeValidationEvidence(join(workspacePath, validationPath), {
    schemaVersion: 1,
    issueIdentifier,
    runId,
    ...(reuseProfile ? { reuseProfile: JSON.parse(reuseProfile) } : {}),
    status: "passed",
    finalResult: {
      status: "passed",
      command: "npm run agent-check",
      exitCode: 0,
      startedAt: now,
      finishedAt: now
    },
    commands: [
      {
        name: "npm run agent-check",
        exitCode: 0,
        startedAt: now,
        finishedAt: now
      }
    ]
  });
}

async function writeHandoffWithoutValidation(workspacePath: string, issueIdentifier: string, body: string): Promise<void> {
  await mkdir(join(workspacePath, ".agent-os"), { recursive: true });
  await writeFile(join(workspacePath, ".agent-os", `handoff-${issueIdentifier}.md`), body, "utf8");
}
