import { access, appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentRunResult, AgentRunner, Issue, IssueTracker } from "../src/types.js";
import { commentWithAgentLifecycleTool, recordHandoffWithAgentLifecycleTool } from "../src/agent-lifecycle.js";
import type { AgentLifecycleTracker } from "../src/agent-lifecycle.js";
import { JsonlLogger } from "../src/logging.js";
import { RunArtifactStore } from "../src/runs.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { IssueStateStore } from "../src/issue-state.js";
import { writeReviewArtifact } from "../src/review.js";
import { writeValidationEvidence } from "../src/validation.js";
import { inspectIssue } from "../src/status.js";

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

const mergingIssue: Issue = {
  ...readyIssue,
  state: "Merging",
  updated_at: "2026-01-02T00:00:00.000Z"
};

const fakeGh = resolve("tests/fixtures/fake-gh.mjs");
const supervisorAssignee = { assignee: "Supervisor", assigneeId: "user-supervisor", assigneeEmail: "supervisor@example.com" };
const supervisorCommentAuthor = { author: "Supervisor", authorId: "user-supervisor", authorEmail: "supervisor@example.com" };
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

class WarningWriteFailingLogger extends JsonlLogger {
  warningAttempts = 0;

  async write(entry: Parameters<JsonlLogger["write"]>[0]) {
    if (entry.type === "phase_timing_persistence_warning") {
      this.warningAttempts += 1;
      throw new Error("warning log write failed");
    }
    return super.write(entry);
  }
}

describe("orchestrator", () => {
  it("dispatches eligible issues to a runner", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      }
    };
    let prompt = "";
    const validationStartedAt = new Date(Date.now() - 5_000).toISOString();
    const validationFinishedAt = new Date(Date.now() - 2_000).toISOString();
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompt = input.prompt;
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied", {
          validationStartedAt,
          validationFinishedAt
        });
        return { status: "succeeded" };
      }
    };
    const logger = new JsonlLogger(repo);

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);
    expect(prompt).toContain("Do AG-1");
    expect(prompt).toContain("## AgentOS Run Context");
    expect(prompt).toContain("Validation evidence path: .agent-os/validation/AG-1.json");
    expect(prompt).toContain("Pack kind: implementation-reentry");
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.timing?.phases.map((phase) => phase.phase)).toEqual(expect.arrayContaining(["implementation", "validation"]));
    expect(summary.timing?.phases.find((phase) => phase.phase === "implementation")).toEqual(
      expect.objectContaining({
        status: "completed",
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        durationMs: expect.any(Number)
      })
    );
    expect(summary.timing?.phases.find((phase) => phase.phase === "validation")).toEqual(
      expect.objectContaining({
        status: "completed",
        startedAt: validationStartedAt,
        finishedAt: validationFinishedAt,
        durationMs: Date.parse(validationFinishedAt) - Date.parse(validationStartedAt),
        metadata: expect.objectContaining({ timingSource: "finalResult" })
      })
    );
    const humanWait = summary.timing?.phases.find((phase) => phase.phase === "human-wait");
    expect(humanWait).toEqual(expect.objectContaining({ status: "waiting", label: "human review wait started" }));
    expect(humanWait?.finishedAt).toBeUndefined();
    const events = await new RunArtifactStore(repo).replay(summary.runId);
    expect(events.some((event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "implementation")).toBe(true);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "validation")).toBe(true);
    expect(events.some((event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "human-wait")).toBe(true);
    const logs = await logger.tail(10);
    expect(logs.some((entry) => entry.type === "run_succeeded")).toBe(true);
    expect(logs.some((entry) => entry.type === "phase_timing" && (entry.payload as { timing?: { phase?: string } }).timing?.phase === "human-wait")).toBe(true);
  });

  it("blocks broad missing work with a planning recommendation before dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-scope-report-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const broadIssue: Issue = {
      ...readyIssue,
      title: "Add orchestration report across Linear GitHub runtime validation docs and workspaces",
      description: [
        "Roadmap item for broad orchestrator observability.",
        "- Audit Linear lifecycle state.",
        "- Inspect GitHub pull request state.",
        "- Read runtime state and run events.",
        "- Include validation and handoff evidence.",
        "- Estimate docs and tests impact.",
        "- Surface workspace recovery and branch state."
      ].join("\n")
    };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [broadIssue];
      },
      async fetchIssueStates() {
        return new Map([[broadIssue.id, broadIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    let runnerCalled = false;
    const moves: string[] = [];
    const comments: string[] = [];
    const logger = new JsonlLogger(repo);

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          runnerCalled = true;
          await writePassingHandoff(input.workspace.path, broadIssue.identifier, input.prompt, "AgentOS-Outcome: already-satisfied");
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const reportEvent = (await logger.tail(50)).find((entry) => entry.type === "pre_dispatch_scope_report");
    const report = reportEvent?.payload as { implementationStatus?: string; scopeSize?: string; likelyLarge?: boolean; dispatchAdvice?: { shouldBlock?: boolean } } | undefined;
    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("planning recommended");
    expect(comments.join("\n")).toContain("Next safe action");
    expect(report).toMatchObject({
      implementationStatus: "missing",
      scopeSize: "large",
      likelyLarge: true,
      dispatchAdvice: { shouldBlock: true }
    });
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state).toMatchObject({
      phase: "needs-input",
      lifecycleStatus: "planning_required",
      stopReason: "likely-large scope needs planning or decomposition before implementation dispatch"
    });
  });

  it("refuses active redispatch when prior handoff already satisfied the issue", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-already-done-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo" };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      outcome: "already_satisfied",
      phase: "completed",
      validation: {
        status: "passed",
        finalStatus: "passed",
        checkedAt: "2026-05-08T00:00:00.000Z"
      },
      updatedAt: "2026-05-08T00:00:00.000Z"
    });
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async move(issueIdentifier, state) {
        moves.push(`${issueIdentifier} -> ${state}`);
      },
      async comment() {}
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.stopReason).toBe("work is already satisfied by prior AgentOS handoff");
  });

  it("includes fetched Linear comments and trusted human decisions in the pre-dispatch scope report", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-scope-comments-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-05-08T00:00:00.000Z" };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-context",
            author: "Teammate",
            createdAt: "2026-05-08T00:01:00.000Z",
            body: "Please preserve the existing branch."
          },
          {
            id: "comment-decision",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-08T00:02:00.000Z",
            body: [
              "AgentOS-Human-Decision: fix-findings",
              "PR-Head-SHA: abc123",
              "CI-State: pending",
              "Findings: open",
              "Decision-Summary: fix the reviewer notes and reuse the existing PR"
            ].join("\n")
          }
        ];
      }
    };
    const logger = new JsonlLogger(repo);

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          await writePassingHandoff(input.workspace.path, issue.identifier, input.prompt, "AgentOS-Outcome: implemented");
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const reportEvent = (await logger.tail(50)).find((entry) => entry.type === "pre_dispatch_scope_report");
    const report = reportEvent?.payload as
      | {
          evidence?: {
            linearComments?: {
              fetched?: boolean;
              count?: number;
              latestCommentAuthor?: string | null;
              recent?: Array<{ id?: string; bodyPreview?: string; hasStructuredHumanDecision?: boolean }>;
            };
            humanDecisions?: {
              present?: boolean;
              count?: number;
              latest?: { type?: string; actor?: string | null; source?: string; authority?: string; commentId?: string; prHeadSha?: string | null };
            };
          };
        }
      | undefined;
    expect(report?.evidence?.linearComments).toMatchObject({
      fetched: true,
      count: 2,
      latestCommentAuthor: "Supervisor"
    });
    expect(report?.evidence?.linearComments?.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "comment-decision",
          hasStructuredHumanDecision: true,
          bodyPreview: expect.stringContaining("AgentOS-Human-Decision: fix-findings")
        })
      ])
    );
    expect(report?.evidence?.humanDecisions).toMatchObject({
      present: true,
      count: 1,
      latest: {
        type: "fix_findings",
        actor: "Supervisor",
        source: "linear-comment",
        authority: "authoritative",
        commentId: "comment-decision",
        prHeadSha: "abc123"
      }
    });
  });

  it("hashes original long runner stdout artifacts written through run events", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-stdout-artifact-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move() {},
      async comment() {}
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        input.onEvent({
          type: "codex_stdout",
          issueId: input.issue.id,
          issueIdentifier: input.issue.identifier,
          message: "line from command\n".repeat(800),
          timestamp: "2026-05-01T00:00:00.000Z"
        });
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const store = new RunArtifactStore(repo);
    const [summary] = await store.listRuns();
    const eventsJsonl = await readFile(join(repo, ".agent-os", "runs", summary.runId, "events.jsonl"), "utf8");
    const stdoutEntry = eventsJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .find((event) => event.type === "codex_stdout");
    const artifact = stdoutEntry?.message?.match(/\[full redacted artifact: ([^\]\n]+)\]/)?.[1];
    expect(artifact).toBeTruthy();
    const artifactHashName = artifact!.replace(`.agent-os/runs/${summary.runId}/`, "");
    const artifactText = await readFile(join(repo, artifact!), "utf8");

    expect(artifactText).toContain("line from command");
    expect(artifactText).not.toContain("full redacted artifact");
    expect((await store.inspect(summary.runId)).summary.artifactHashes[artifactHashName]).toBeTruthy();
    await appendFile(join(repo, artifact!), "\ntampered", "utf8");
    expect((await store.inspect(summary.runId)).warnings).toContain(`artifact hash mismatch: ${artifactHashName}`);

    await rm(join(repo, artifact!));
    expect((await store.inspect(summary.runId)).warnings).toContain(`artifact hash mismatch: ${artifactHashName}`);
  });

  it("skips Todo issues blocked by nonterminal dependencies", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-blocked-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const blockedIssue = {
      ...readyIssue,
      state: "Todo",
      blocked_by: [{ id: "blocker-1", identifier: "AG-0", state: "In Progress" }]
    };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [blockedIssue];
      },
      async fetchIssueStates() {
        return new Map([[blockedIssue.id, blockedIssue]]);
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
  });

  it("includes structured Linear human decisions in Todo re-entry prompts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-human-reentry-"));
    await initGitRemote(repo);
    const ghStatePath = join(repo, "gh-state.json");
    await writeFile(
      ghStatePath,
      JSON.stringify(
        {
          view: {
            url: "https://github.com/o/r/pull/7",
            state: "OPEN",
            isDraft: true,
            mergeable: "MERGEABLE",
            headRefOid: "abc123",
            statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: null }],
            files: [{ path: "src/example.ts" }],
            comments: []
          }
        },
        null,
        2
      ),
      "utf8"
    );
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghStatePath)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-01-02T00:00:00.000Z" };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      prs: [{ url: "https://github.com/o/r/pull/7", role: "primary", source: "handoff", discoveredAt: "2026-01-01T00:00:00.000Z" }],
      prUrl: "https://github.com/o/r/pull/7",
      reviewStatus: "human_required",
      reviewIteration: 2,
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-1",
            ...supervisorCommentAuthor,
            createdAt: "2026-01-02T00:01:00.000Z",
            body: [
              "AgentOS-Human-Decision: fix-findings",
              "PR-Head-SHA: abc123",
              "CI-State: pending",
              "Findings: open",
              "Decision-Summary: fix the reviewer notes and reuse the existing PR"
            ].join("\n")
          }
        ];
      }
    };
    let prompt = "";
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompt = input.prompt;
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(prompt).toContain("## Linear Human Decision Re-entry");
    expect(prompt).toContain("Type: fix_findings");
    expect(prompt).toContain("PR head SHA: abc123");
    expect(prompt).toContain("Existing PR Feedback Re-entry");
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.lastHumanDecision?.type).toBe("fix_findings");
    expect(state?.lifecycleStatus).toBe("human_continuation");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("allows trusted fix-findings re-entry for completed human-required review states with PR metadata", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-completed-human-required-reentry-"));
    await initGitRemote(repo);
    const ghStatePath = join(repo, "gh-state.json");
    await writeFile(
      ghStatePath,
      JSON.stringify(
        {
          view: {
            url: "https://github.com/o/r/pull/7",
            state: "OPEN",
            isDraft: true,
            mergeable: "MERGEABLE",
            headRefOid: "abc123",
            statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: null }],
            files: [{ path: "src/example.ts" }],
            comments: []
          }
        },
        null,
        2
      ),
      "utf8"
    );
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghStatePath)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-01-02T00:00:00.000Z" };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "completed",
      prs: [{ url: "https://github.com/o/r/pull/7", role: "primary", source: "handoff", discoveredAt: "2026-01-01T00:00:00.000Z" }],
      prUrl: "https://github.com/o/r/pull/7",
      reviewStatus: "human_required",
      reviewIteration: 2,
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-1",
            ...supervisorCommentAuthor,
            createdAt: "2026-01-02T00:01:00.000Z",
            body: [
              "AgentOS-Human-Decision: fix-findings",
              "PR-Head-SHA: abc123",
              "CI-State: pending",
              "Findings: open",
              "Decision-Summary: fix the reviewer notes and reuse the existing PR"
            ].join("\n")
          }
        ];
      }
    };
    let prompt = "";

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          prompt = input.prompt;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(1);
    expect(prompt).toContain("## Linear Human Decision Re-entry");
    expect(prompt).toContain("Type: fix_findings");
    expect(prompt).toContain("Existing PR Feedback Re-entry");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("updates stored human decisions when a trusted Linear comment is edited", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-human-reentry-edited-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-01-03T00:00:00.000Z" };
    const runStore = new RunArtifactStore(repo);
    const priorRun = await runStore.startRun({ issue, attempt: null });
    await runStore.startPhase(priorRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.completeRun(priorRun.runId, { status: "succeeded" });
    const originalDecision = {
      type: "fix_findings" as const,
      decidedAt: "2026-01-02T00:00:00.000Z",
      source: "linear-comment" as const,
      actor: "Supervisor",
      actorId: "user-supervisor",
      actorEmail: "supervisor@example.com",
      trusted: true,
      commentId: "comment-1",
      body: "AgentOS-Human-Decision: fix-findings"
    };
      await new IssueStateStore(repo).write({
        schemaVersion: 1,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        phase: "review",
        lifecycleStatus: "human_continuation",
      lastRunId: priorRun.runId,
      humanDecisions: [originalDecision],
      lastHumanDecision: originalDecision,
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-1",
            ...supervisorCommentAuthor,
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-03T00:01:00.000Z",
            body: ["AgentOS-Human-Decision: approve-as-is", "Decision-Summary: approved after reviewer recheck"].join("\n")
          }
        ];
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("supervisor continuation should pause redispatch");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.lastHumanDecision).toMatchObject({
      type: "approve_as_is",
      decidedAt: "2026-01-03T00:01:00.000Z",
      summary: "approved after reviewer recheck"
    });
    expect(state?.humanDecisions).toHaveLength(1);
    expect(state?.humanDecisions?.[0]?.type).toBe("approve_as_is");
    expect(state?.lifecycleStatus).toBe("supervisor_continuation");
    const prior = await runStore.inspect(priorRun.runId);
    expect(prior.summary.timing?.phases.find((phase) => phase.phase === "human-wait")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: "2026-01-03T00:01:00.000Z"
      })
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("reconciles stored trusted decisions against the full Linear comment set before dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-human-reentry-deleted-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-01-04T00:00:00.000Z" };
    const staleDecision = {
      type: "fix_findings" as const,
      decidedAt: "2026-01-02T00:00:00.000Z",
      source: "linear-comment" as const,
      actor: "Supervisor",
      actorId: "user-supervisor",
      actorEmail: "supervisor@example.com",
      trusted: true,
      commentId: "comment-deleted",
      body: "AgentOS-Human-Decision: fix-findings"
    };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      reviewStatus: "human_required",
      lifecycleStatus: "human_continuation",
      humanDecisions: [staleDecision],
      lastHumanDecision: staleDecision,
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments(_issue, limit) {
        expect(limit).toBe(Number.MAX_SAFE_INTEGER);
        return Array.from({ length: 25 }, (_, index) => ({
          id: `comment-noise-${index + 1}`,
          author: "Teammate",
          authorId: `user-${index + 1}`,
          authorEmail: `user${index + 1}@example.com`,
          createdAt: `2026-01-03T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
          body: `follow-up ${index + 1}`
        }));
      },
      async move(issueIdentifier, state) {
        moves.push(`${issueIdentifier} -> ${state}`);
      }
    };
    const moves: string[] = [];
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.humanDecisions ?? []).toEqual([]);
    expect(state?.lastHumanDecision).toBeNull();
    expect(state?.lifecycleStatus).toBeUndefined();
    expect(state?.stopReason).toBe("human-required issue needs a trusted structured decision before redispatch");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not recommend redispatch from stale fix-findings when Linear comments cannot be reconciled", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-human-reentry-comment-read-failed-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-01-04T00:00:00.000Z" };
    const staleDecision = {
      type: "fix_findings" as const,
      decidedAt: "2026-01-02T00:00:00.000Z",
      source: "linear-comment" as const,
      actor: "Supervisor",
      actorId: "user-supervisor",
      actorEmail: "supervisor@example.com",
      trusted: true,
      commentId: "comment-stale",
      body: "AgentOS-Human-Decision: fix-findings"
    };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      reviewStatus: "human_required",
      lifecycleStatus: "human_continuation",
      humanDecisions: [staleDecision],
      lastHumanDecision: staleDecision,
      updatedAt: "2026-01-02T00:00:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        throw new Error("Linear temporarily unavailable");
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.phase).toBe("needs-input");
    expect(state?.lifecycleStatus).toBeUndefined();
    expect(state?.stopReason).toContain("could not read latest Linear comments before dispatch guardrails");
    const inspectOutput = await inspectIssue(repo, "AG-1");
    expect(inspectOutput).toContain("restore Linear comment access");
    expect(inspectOutput).not.toContain("redispatch from Todo/In Progress");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("closes human decision waits on the prior run without duplicating timing on the new run", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-human-reentry-timing-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-01-02T00:00:00.000Z" };
    const runStore = new RunArtifactStore(repo);
    const priorRun = await runStore.startRun({ issue, attempt: null });
    await runStore.startPhase(priorRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.completeRun(priorRun.runId, { status: "succeeded" });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      lastRunId: priorRun.runId,
      reviewStatus: "human_required",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-1",
            ...supervisorCommentAuthor,
            createdAt: "2026-01-02T00:01:00.000Z",
            body: "AgentOS-Human-Decision: fix-findings"
          }
        ];
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const prior = await runStore.inspect(priorRun.runId);
    expect(prior.summary.timing?.phases.find((phase) => phase.phase === "human-wait")).toEqual(
      expect.objectContaining({
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-02T00:01:00.000Z"
      })
    );
    const summaries = await runStore.listRuns();
    const newRun = summaries.find((summary) => summary.runId !== priorRun.runId);
    const newHumanWaits = newRun?.timing?.phases.filter((phase) => phase.phase === "human-wait") ?? [];
    expect(newHumanWaits).toHaveLength(1);
    expect(newHumanWaits[0]).toEqual(expect.objectContaining({ status: "waiting", label: "human review wait started" }));
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("closes needs-input waits when a trusted human decision resumes the issue", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-needs-input-reentry-timing-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee, updated_at: "2026-01-02T00:00:00.000Z" };
    const runStore = new RunArtifactStore(repo);
    const priorRun = await runStore.startRun({ issue, attempt: null });
    await runStore.startPhase(priorRun.runId, {
      phase: "needs-input",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "needs-input pause started"
    });
    await runStore.completeRun(priorRun.runId, { status: "failed", error: "codex_elicitation_request_denied" });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "needs-input",
      lifecycleStatus: "implementation_failure",
      lastRunId: priorRun.runId,
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-1",
            ...supervisorCommentAuthor,
            createdAt: "2026-01-02T00:01:00.000Z",
            body: "AgentOS-Human-Decision: fix-findings"
          }
        ];
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const prior = await runStore.inspect(priorRun.runId);
    expect(prior.summary.timing?.phases.find((phase) => phase.phase === "needs-input")).toEqual(
      expect.objectContaining({
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-02T00:01:00.000Z"
      })
    );
    expect(prior.summary.timing?.phases.some((phase) => phase.phase === "human-wait")).toBe(false);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("keeps untrusted human-decision comments as context without lifecycle authority", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-untrusted-human-reentry-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-1",
            author: "Random User",
            authorId: "user-random",
            authorEmail: "random@example.com",
            createdAt: "2026-01-02T00:01:00.000Z",
            body: "AgentOS-Human-Decision: approve-as-is"
          }
        ];
      }
    };
    let prompt = "";
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompt = input.prompt;
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
        return { status: "succeeded" };
      }
    };

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(1);
    expect(prompt).toContain("Recent Linear comments:");
    expect(prompt).toContain("AgentOS-Human-Decision: approve-as-is");
    expect(prompt).toContain("Authoritative structured human decision: none recorded.");
    expect(prompt).toContain("Context-only structured human decision:");
    expect(prompt).toContain("- Authority: context-only");
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.lastHumanDecision).toMatchObject({
      type: "approve_as_is",
      source: "linear-comment",
      actor: "Random User",
      trusted: false
    });
    expect(state?.lifecycleStatus).toBeUndefined();
  });

  it("uses configured trusted decision actors by stable identity while keeping unlisted comments non-authoritative", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-trusted-config-human-reentry-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nlifecycle:\n  trusted_decision_actors:\n    - trusted@example.com\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = {
      ...readyIssue,
      state: "Todo",
      assignee: "Issue Owner",
      assigneeId: "user-owner",
      assigneeEmail: "owner@example.com"
    };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      reviewStatus: "human_required",
      updatedAt: "2026-05-10T00:00:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-trusted",
            author: "Release Manager",
            authorId: "user-release-manager",
            authorEmail: "trusted@example.com",
            createdAt: "2026-05-10T00:01:00.000Z",
            body: "AgentOS-Human-Decision: fix-findings"
          },
          {
            id: "comment-unlisted",
            author: "Random User",
            authorId: "user-random",
            authorEmail: "random@example.com",
            createdAt: "2026-05-10T00:02:00.000Z",
            body: "AgentOS-Human-Decision: approve-as-is"
          }
        ];
      }
    };
    let prompt = "";

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          prompt = input.prompt;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(1);
    expect(prompt).toContain("Structured human decision:");
    expect(prompt).toContain("Type: fix_findings");
    expect(prompt).toContain("AgentOS-Human-Decision: approve-as-is");
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.lastHumanDecision).toMatchObject({
      type: "fix_findings",
      actor: "Release Manager",
      actorEmail: "trusted@example.com",
      trusted: true
    });
    expect(state?.humanDecisions?.map((decision) => [decision.commentId, decision.trusted])).toEqual([
      ["comment-trusted", true],
      ["comment-unlisted", false]
    ]);
  });

  it("does not let handoff-sourced human decisions bypass human-required dispatch guardrails", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-handoff-decision-untrusted-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  needs_input_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo" };
    const handoffDecision = {
      type: "fix_findings" as const,
      source: "handoff" as const,
      decidedAt: "2026-05-10T00:00:00.000Z",
      body: "AgentOS-Human-Decision: fix-findings"
    };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      reviewStatus: "human_required",
      humanDecisions: [handoffDecision],
      lastHumanDecision: handoffDecision,
      updatedAt: "2026-05-10T00:00:00.000Z"
    });
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async move(issueIdentifier, state) {
        moves.push(`${issueIdentifier} -> ${state}`);
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.stopReason).toBe("human-required issue needs a trusted structured decision before redispatch");
  });

  it("labels handoff-sourced structured decisions as context-only in re-entry prompts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-handoff-decision-context-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo" };
    const handoffDecision = {
      type: "fix_findings" as const,
      source: "handoff" as const,
      decidedAt: "2026-05-10T00:00:00.000Z",
      body: "AgentOS-Human-Decision: fix-findings"
    };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "review",
      humanDecisions: [handoffDecision],
      lastHumanDecision: handoffDecision,
      updatedAt: "2026-05-10T00:00:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [];
      }
    };
    let prompt = "";

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          prompt = input.prompt;
          await writePassingHandoff(input.workspace.path, issue.identifier, input.prompt, "AgentOS-Outcome: implemented");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(1);
    expect(prompt).toContain("Authoritative structured human decision: none recorded.");
    expect(prompt).toContain("Context-only structured human decision:");
    expect(prompt).toContain("- Authority: context-only");
    expect(prompt).toContain("- Source: handoff");
    expect(prompt).not.toContain("- Authority: authoritative");
  });

  it("lets newer supervisor-fix decisions override older fix-findings comments before dispatch guardrails", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-supervisor-overrides-fix-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee };
      await new IssueStateStore(repo).write({
        schemaVersion: 1,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        phase: "review",
        reviewStatus: "human_required",
      updatedAt: "2026-05-10T00:00:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-fix",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-10T00:01:00.000Z",
            body: "AgentOS-Human-Decision: fix-findings"
          },
          {
            id: "comment-supervisor-fixed",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-10T00:02:00.000Z",
            body: [
              "AgentOS-Human-Decision: proceed-to-merge-after-supervisor-fix",
              "PR-Head-SHA: abc123",
              "Validation-JSON: .agent-os/validation/AG-1.json",
              "CI-State: passed",
              "Findings: resolved",
              "Decision-Summary: supervisor repaired the branch outside Codex"
            ].join("\n")
          }
        ];
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.lastHumanDecision).toMatchObject({
      type: "proceed_to_merge_after_supervisor_fix",
      commentId: "comment-supervisor-fixed",
      prHeadSha: "abc123"
    });
    expect(state?.lifecycleStatus).toBe("externally_fixed");
    expect(state?.stopReason).toContain("supervisor continuation or external fix is active");
  });

  it("preserves newer stored trusted supervisor decisions when older trusted comments are ingested", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-preserve-local-supervisor-decision-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee };
    const supervisorFixedDecision = {
      type: "proceed_to_merge_after_supervisor_fix" as const,
      source: "linear-comment" as const,
      trusted: true,
      decidedAt: "2026-05-10T00:03:00.000Z",
      actor: "Supervisor",
      actorId: "user-supervisor",
      actorEmail: "supervisor@example.com",
      commentId: "comment-newer-supervisor-fixed",
      body: "AgentOS-Human-Decision: proceed-to-merge-after-supervisor-fix",
      prHeadSha: "fixed-head"
    };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "review",
      reviewStatus: "human_required",
      lastHumanDecision: supervisorFixedDecision,
      updatedAt: "2026-05-10T00:03:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-older-fix",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-10T00:01:00.000Z",
            body: "AgentOS-Human-Decision: fix-findings"
          },
          {
            id: "comment-newer-supervisor-fixed",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-10T00:03:00.000Z",
            body: "AgentOS-Human-Decision: proceed-to-merge-after-supervisor-fix\nPR-Head-SHA: fixed-head"
          }
        ];
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          runnerCalled = true;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.lastHumanDecision).toMatchObject({
      type: "proceed_to_merge_after_supervisor_fix",
      source: "linear-comment",
      commentId: "comment-newer-supervisor-fixed",
      prHeadSha: "fixed-head"
    });
    expect(state?.humanDecisions?.map((decision) => decision.type)).toEqual(["fix_findings", "proceed_to_merge_after_supervisor_fix"]);
    expect(state?.lifecycleStatus).toBe("externally_fixed");
  });

  it("keeps unproven manual supervisor decisions context-only before dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-manual-decision-context-only-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  needs_input_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      reviewStatus: "human_required",
      humanDecisions: [
        {
          type: "proceed_to_merge_after_supervisor_fix",
          source: "manual",
          decidedAt: "2026-05-10T00:03:00.000Z",
          actor: "local-supervisor",
          body: "AgentOS-Human-Decision: proceed-to-merge-after-supervisor-fix",
          prHeadSha: "fixed-head"
        }
      ],
      lastHumanDecision: {
        type: "proceed_to_merge_after_supervisor_fix",
        source: "manual",
        decidedAt: "2026-05-10T00:03:00.000Z",
        actor: "local-supervisor",
        body: "AgentOS-Human-Decision: proceed-to-merge-after-supervisor-fix",
        prHeadSha: "fixed-head"
      },
      lifecycleStatus: "externally_fixed",
      updatedAt: "2026-05-10T00:03:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [];
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.lastHumanDecision).toMatchObject({
      type: "proceed_to_merge_after_supervisor_fix",
      source: "manual"
    });
    expect(state?.lifecycleStatus).toBeUndefined();
    expect(state?.stopReason).toBe("human-required issue needs a trusted structured decision before redispatch");
  });

  it("retracts stored Linear decisions when fetched trusted comments no longer contain structured decisions", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-retract-human-decision-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  needs_input_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      reviewStatus: "human_required",
      humanDecisions: [
        {
          type: "fix_findings",
          source: "linear-comment",
          trusted: true,
          actor: "Supervisor",
          actorId: "user-supervisor",
          actorEmail: "supervisor@example.com",
          decidedAt: "2026-05-10T00:01:00.000Z",
          commentId: "comment-retracted",
          body: "AgentOS-Human-Decision: fix-findings"
        }
      ],
      lastHumanDecision: {
        type: "fix_findings",
        source: "linear-comment",
        trusted: true,
        actor: "Supervisor",
        actorId: "user-supervisor",
        actorEmail: "supervisor@example.com",
        decidedAt: "2026-05-10T00:01:00.000Z",
        commentId: "comment-retracted",
        body: "AgentOS-Human-Decision: fix-findings"
      },
      lifecycleStatus: "human_continuation",
      updatedAt: "2026-05-10T00:01:00.000Z"
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-retracted",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-10T00:01:00.000Z",
            updatedAt: "2026-05-10T00:04:00.000Z",
            body: "Retracting the prior decision until I can review it again."
          }
        ];
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.humanDecisions ?? []).toEqual([]);
    expect(state?.lastHumanDecision).toBeNull();
    expect(state?.lifecycleStatus).toBeUndefined();
    expect(state?.stopReason).toBe("human-required issue needs a trusted structured decision before redispatch");
  });

  it("fails closed when Linear comments cannot be read before dispatch guardrails", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-comment-read-fail-closed-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const issue = { ...readyIssue, state: "Todo", ...supervisorAssignee };
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "review",
      reviewStatus: "human_required",
      humanDecisions: [
        {
          type: "fix_findings",
          source: "linear-comment",
          trusted: true,
          actor: "Supervisor",
          actorId: "user-supervisor",
          actorEmail: "supervisor@example.com",
          decidedAt: "2026-05-10T00:01:00.000Z",
          commentId: "comment-old"
        }
      ],
      lastHumanDecision: {
        type: "fix_findings",
        source: "linear-comment",
        trusted: true,
        actor: "Supervisor",
        actorId: "user-supervisor",
        actorEmail: "supervisor@example.com",
        decidedAt: "2026-05-10T00:01:00.000Z",
        commentId: "comment-old"
      },
      lifecycleStatus: "human_continuation",
      updatedAt: "2026-05-10T00:01:00.000Z"
    });
    const fakeLinearToken = `lin_${"1".repeat(20)}`;
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        throw new Error(`Linear comments unavailable: Authorization: Bearer ${fakeLinearToken}`);
      }
    };
    let runnerCalled = false;
    const logger = new JsonlLogger(repo);

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          runnerCalled = true;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.stopReason).toContain("could not read latest Linear comments before dispatch guardrails");
    expect(JSON.stringify(state)).not.toContain(fakeLinearToken);
    expect(state?.stopReason).toContain("[REDACTED]");
    expect(state?.lastHumanDecision?.type).toBe("fix_findings");
    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "linear_comment_read_failed")).toBe(true);
    expect(logs.some((entry) => entry.type === "dispatch_skipped" && entry.message.includes("could not read latest Linear comments"))).toBe(true);
  });

  it("suppresses stale active runs and redispatch during supervisor continuation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-supervisor-paused-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await new RuntimeStateStore(repo).upsertActiveRun({
      issueId: readyIssue.id,
      identifier: readyIssue.identifier,
      issue: readyIssue,
      attempt: 0,
      runId: "run-stale",
      startedAt: "2026-05-05T00:00:00.000Z",
      phase: "streaming-turn"
    });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: readyIssue.id,
      issueIdentifier: readyIssue.identifier,
      phase: "review",
      lifecycleStatus: "externally_fixed",
      lastHumanDecision: {
        type: "proceed_to_merge_after_supervisor_fix",
        source: "linear-comment",
        actor: "Supervisor",
        actorId: "user-supervisor",
        actorEmail: "supervisor@example.com",
        trusted: true,
        decidedAt: "2026-05-05T00:01:00.000Z",
        commentId: "comment-1"
      },
      updatedAt: "2026-05-05T00:01:00.000Z"
    });
    let runnerCalled = false;
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      }
    };

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.activeRuns).toHaveLength(0);
    expect(runtime.retryQueue).toHaveLength(0);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.stopReason).toContain("supervisor continuation or external fix is active");
  });

  it("records missing credential preflight and refuses dispatch before tracker reads", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-preflight-missing-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const logger = new JsonlLogger(repo);
    await new RuntimeStateStore(repo).upsertActiveRun({
      issueId: readyIssue.id,
      identifier: readyIssue.identifier,
      issue: readyIssue,
      attempt: 0,
      runId: "run-stale",
      startedAt: "2026-05-05T00:00:00.000Z",
      phase: "streaming-turn"
    });
    let trackerReads = 0;
    const tracker: IssueTracker = {
      async fetchCandidates() {
        trackerReads += 1;
        throw new Error("tracker should not be read when preflight fails");
      },
      async fetchIssueStates() {
        trackerReads += 1;
        throw new Error("tracker should not be read when preflight fails");
      },
      async fetchTerminalIssues() {
        trackerReads += 1;
        throw new Error("tracker should not be read when preflight fails");
      }
    };

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      logger,
      env: { HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(trackerReads).toBe(0);
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.daemon?.preflightStatus).toBe("missing_credentials");
    expect(runtime.daemon?.preflightMessage).toContain("tracker.api_key is required");
    expect((await logger.tail(10)).some((entry) => entry.type === "daemon_preflight_failed")).toBe(true);
  });

  it("loads repo-local .agent-os/env before daemon preflight", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-preflight-loaded-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "env"), "LINEAR_API_KEY=lin_from_file\n", "utf8");
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map();
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called");
        }
      },
      logger: new JsonlLogger(repo),
      env: { HOME: "/tmp" }
    }).runOnce(true);

    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.daemon?.preflightStatus).toBe("ready");
    expect(runtime.daemon?.repoEnvStatus).toBe("loaded");
    expect(runtime.daemon?.credentialPreflight?.loadedKeys).toContain("LINEAR_API_KEY");
  });

  it("owns Linear lifecycle updates and posts the agent handoff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-linear-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\n  needs_input_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "### Handoff\n\nValidation passed.\n\nPR: https://github.com/o/r/pull/1");
        return { status: "succeeded" };
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(comments[0]).toContain("AgentOS started");
    expect(comments[1]).toContain("Validation passed.");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("keeps hybrid lifecycle moves and bookkeeping comments but not full handoff comments", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-hybrid-linear-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\nlifecycle:\n  mode: hybrid\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "### Handoff\n\nValidation passed.\n\nPR: https://github.com/o/r/pull/1");
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(comments[0]).toContain("AgentOS started");
    expect(comments[1]).toContain("AgentOS handoff recorded");
    expect(comments[1]).not.toContain("Validation passed.");
    expect(comments[1]).toContain("lifecycle.mode: hybrid");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  it("lets hybrid workers write substantive ticket content while scheduler owns state moves", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-hybrid-worker-boundary-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "lifecycle:",
        "  mode: hybrid",
        "  allowed_tracker_tools:",
        "    - scripts/agent-linear-comment.sh",
        "    - scripts/agent-linear-handoff.sh",
        "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} -->\"",
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
        "review:",
        "  enabled: false",
        "---",
        "Do {{ issue.identifier }}"
      ].join("\n"),
      "utf8"
    );

    const issue = { ...readyIssue, ...supervisorAssignee };
    const moves: string[] = [];
    const schedulerComments: string[] = [];
    const agentComments: Array<{ issue: string; body: string; marker: string; duplicateBehavior?: string }> = [];
    const tracker: IssueTracker & AgentLifecycleTracker = {
      async fetchCandidates() {
        return [issue];
      },
      async fetchIssueStates() {
        return new Map([[issue.id, issue]]);
      },
      async fetchIssueComments() {
        return [
          {
            id: "comment-context-only",
            author: "Random User",
            authorId: "user-random",
            authorEmail: "random@example.com",
            createdAt: "2026-05-10T00:01:00.000Z",
            body: "AgentOS-Human-Decision: approve-as-is"
          },
          {
            id: "comment-authoritative",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-10T00:02:00.000Z",
            body: ["AgentOS-Human-Decision: fix-findings", "Decision-Summary: continue with the bounded hybrid fixture"].join("\n")
          }
        ];
      },
      async move(issueIdentifier, state) {
        moves.push(`${issueIdentifier} -> ${state}`);
      },
      async comment(_issueIdentifier, body) {
        schedulerComments.push(body);
      },
      async findIssueReference() {
        return {
          id: issue.id,
          identifier: issue.identifier,
          state: issue.state,
          team: { id: "team-1", key: "AG", name: "AgentOS" }
        };
      },
      async upsertCommentWithMarker(issueIdentifier, body, marker, duplicateBehavior) {
        agentComments.push({ issue: issueIdentifier, body, marker, duplicateBehavior });
        return "created";
      }
    };
    let prompt = "";
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompt = input.prompt;
        await initGitRemote(input.workspace.path);
        await commentWithAgentLifecycleTool(
          { repoRoot: input.workspace.path, config: input.config, tracker },
          {
            issue: issue.identifier,
            event: "worker_status",
            tool: "scripts/agent-linear-comment.sh",
            body: "Worker substantive update: validation is passing and the handoff is ready."
          }
        );
        await writePassingHandoff(
          input.workspace.path,
          issue.identifier,
          input.prompt,
          "AgentOS-Outcome: implemented\n\nWorker-authored handoff content.\n\nPR: https://github.com/o/r/pull/1"
        );
        await recordHandoffWithAgentLifecycleTool(
          { repoRoot: input.workspace.path, config: input.config, tracker },
          {
            issue: issue.identifier,
            handoffPath: join(input.workspace.path, ".agent-os", `handoff-${issue.identifier}.md`),
            tool: "scripts/agent-linear-handoff.sh"
          }
        );
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(prompt).toContain("- Authority: authoritative");
    expect(prompt).toContain("- Source: linear-comment");
    expect(prompt).toContain("- Actor: Supervisor");
    expect(prompt).toContain("Context-only structured human decision:");
    expect(prompt).toContain("Random User");
    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(schedulerComments[0]).toContain("AgentOS started");
    expect(schedulerComments[1]).toContain("AgentOS handoff recorded");
    expect(schedulerComments[1]).not.toContain("Worker-authored handoff content");
    expect(agentComments).toEqual([
      expect.objectContaining({
        issue: "AG-1",
        marker: "<!-- agentos:event=worker_status issue=AG-1 -->",
        body: expect.stringContaining("Worker substantive update"),
        duplicateBehavior: "upsert"
      }),
      expect.objectContaining({
        issue: "AG-1",
        marker: "<!-- agentos:event=run_handoff issue=AG-1 -->",
        body: expect.stringContaining("Worker-authored handoff content"),
        duplicateBehavior: "upsert"
      })
    ]);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(state?.lastHumanDecision).toMatchObject({
      type: "fix_findings",
      actor: "Supervisor",
      source: "linear-comment",
      trusted: true
    });
    expect(state?.humanDecisions?.map((decision) => [decision.commentId, decision.trusted])).toEqual([
      ["comment-context-only", false],
      ["comment-authoritative", true]
    ]);
  });

  it("refuses unconfigured agent-owned lifecycle dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-agent-owned-loose-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\nlifecycle:\n  mode: agent-owned\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    const tracker: IssueTracker = {
      async fetchCandidates() {
        throw new Error("agent-owned validation should fail before dispatch");
      },
      async fetchIssueStates() {
        return new Map();
      }
    };

    await expect(
      new Orchestrator({
        repoRoot: repo,
        workflowPath,
        tracker,
        runner: {
          async run(): Promise<AgentRunResult> {
            throw new Error("runner should not be called");
          }
        },
        logger: new JsonlLogger(repo),
        env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
      }).runOnce(true)
    ).rejects.toThrow("lifecycle.mode=agent-owned requires lifecycle.allowed_tracker_tools in strict mode");
  });

  it("passes retry attempts and does not re-dispatch an unchanged successful issue", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-retry-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nagent:\n  max_turns: 1\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nAttempt {{ attempt | default: 0 }} for {{ issue.identifier }}`,
      "utf8"
    );

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      }
    };
    const prompts: string[] = [];
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompts.push(input.prompt);
        if (prompts.length === 1) return { status: "failed", error: "boom" };
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
        return { status: "succeeded" };
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await orchestrator.runOnce(true);
    await orchestrator.runOnce(true);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Attempt 0 for AG-1");
    expect(prompts[1]).toContain("Attempt 1 for AG-1");
    expect(prompts[0]).toContain("## AgentOS Run Context");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({ phase: "completed" });
    expect(state.lastError).toBeUndefined();
    expect(state.errorCategory).toBeUndefined();
    expect(state.nextRetryAt).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("rebuilds due retries from durable runtime state after restart", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-durable-retry-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nagent:\n  max_turns: 1\n  max_retry_attempts: 2\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nAttempt {{ attempt | default: 0 }} for {{ issue.identifier }}`,
      "utf8"
    );

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async comment() {},
      async move() {}
    };
    const firstRunner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        return { status: "failed", error: "boom" };
      }
    };
    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: firstRunner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);
    await sleep(5);

    const prompts: string[] = [];
    const secondRunner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompts.push(input.prompt);
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
        return { status: "succeeded" };
      }
    };
    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: secondRunner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Attempt 1 for AG-1");
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.retryQueue).toEqual([]);
    expect(runtime.activeRuns).toEqual([]);
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.phase).toBe("completed");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("marks stale running summaries terminal when Linear is Done and the workspace is gone", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-stale-terminal-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  terminal_states: [Done, Canceled, Duplicate]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(workspacePath, { recursive: true });
    const store = new RunArtifactStore(repo);
    const running = await store.startRun({ issue: readyIssue, attempt: null, workspace: { path: workspacePath, workspaceKey: "AG-1", createdNow: true } });
    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        phase: "streaming-turn",
        reviewStatus: "human_required",
        lastError: "stale review failure",
        errorCategory: "review",
        retryAttempt: 2,
        nextRetryAt: "2026-01-03T00:10:00.000Z",
        lastRunId: running.runId,
        workspacePath,
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    const doneIssue = { ...readyIssue, state: "Done", updated_at: "2026-01-03T00:00:00.000Z" };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, doneIssue]]);
      },
      async fetchTerminalIssues() {
        return [doneIssue];
      },
      async comment() {},
      async move() {}
    };
    let runnerCalled = false;

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(runnerCalled).toBe(false);
    expect((await store.inspect(running.runId)).summary.status).toBe("canceled");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "completed",
      lifecycleStatus: "terminal_missing_workspace",
      terminalState: "Done"
    });
    expect(state.reviewStatus).toBeUndefined();
    expect(state.lastError).toBeUndefined();
    expect(state.errorCategory).toBeUndefined();
    expect(state.retryAttempt).toBeUndefined();
    expect(state.nextRetryAt).toBeUndefined();
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.activeRuns).toEqual([]);
    expect(runtime.retryQueue).toEqual([]);
  });

  it("resolves terminal workspace existence under the target repo before cleanup", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-terminal-workspace-root-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  terminal_states: [Done]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(workspacePath, { recursive: true });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: readyIssue.id,
      issueIdentifier: readyIssue.identifier,
      phase: "streaming-turn",
      workspacePath: ".agent-os/workspaces/AG-1",
      workspaceMissingAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const doneIssue = { ...readyIssue, state: "Done", updated_at: "2026-01-03T00:00:00.000Z" };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, doneIssue]]);
      },
      async fetchTerminalIssues() {
        return [doneIssue];
      },
      async comment() {},
      async move() {}
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for terminal issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state).toMatchObject({
      lifecycleStatus: "terminal_linear",
      terminalState: "Done"
    });
    expect(state?.workspaceMissingAt).toBeUndefined();
    await expect(access(workspacePath)).rejects.toThrow();

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for terminal issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const secondPassState = await new IssueStateStore(repo).read("AG-1");
    expect(secondPassState).toMatchObject({
      lifecycleStatus: "terminal_linear",
      terminalState: "Done"
    });
    expect(secondPassState?.workspaceMissingAt).toBeUndefined();
    const inspectOutput = await inspectIssue(repo, "AG-1");
    expect(inspectOutput).toContain("Status warnings: none");
    expect(inspectOutput).not.toContain("missing terminal workspace warning");
    expect(inspectOutput).not.toContain("Workspace recovery: workspace missing");
  });

  it("refreshes terminal Linear heads from newer CI metadata when no PR status is available", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-terminal-ci-head-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  terminal_states: [Done]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: readyIssue.id,
      issueIdentifier: readyIssue.identifier,
      phase: "review",
      headSha: "stale-recorded-head",
      lastReviewedSha: "stale-reviewed-head",
      lastFixedSha: "stale-fixed-head",
      validation: {
        status: "passed",
        checkedAt: "2026-01-01T00:00:00.000Z",
        githubCi: {
          status: "passed",
          headSha: "newer-ci-head",
          checkedAt: "2026-01-02T00:00:00.000Z"
        }
      },
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const doneIssue = { ...readyIssue, state: "Done", updated_at: "2026-01-03T00:00:00.000Z" };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, doneIssue]]);
      },
      async comment() {},
      async move() {}
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for terminal issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state).toMatchObject({
      phase: "completed",
      lifecycleStatus: "terminal_missing_workspace",
      terminalState: "Done",
      headSha: "newer-ci-head",
      lastReviewedSha: "newer-ci-head",
      lastFixedSha: "newer-ci-head",
      validation: expect.objectContaining({
        githubCi: expect.objectContaining({
          status: "passed",
          headSha: "newer-ci-head"
        })
      })
    });
  });

  it("closes stored wait phases when a recorded issue becomes terminal", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-terminal-waits-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  terminal_states: [Done, Canceled, Duplicate]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const runStore = new RunArtifactStore(repo);
    const completedRun = await runStore.startRun({ issue: readyIssue, attempt: null });
    await runStore.startPhase(completedRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.startPhase(completedRun.runId, {
      phase: "needs-input",
      status: "waiting",
      startedAt: "2026-01-01T00:05:00.000Z",
      label: "needs-input pause started"
    });
    await runStore.startPhase(completedRun.runId, {
      phase: "ci-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:10:00.000Z",
      label: "ci wait started"
    });
    await runStore.completeRun(completedRun.runId, { status: "succeeded" });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: readyIssue.id,
      issueIdentifier: readyIssue.identifier,
      phase: "review",
      lastRunId: completedRun.runId,
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const doneIssue = { ...readyIssue, state: "Done", updated_at: "2026-01-03T00:00:00.000Z" };
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, doneIssue]]);
      },
      async comment() {},
      async move() {}
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for terminal issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const state = await new IssueStateStore(repo).read(readyIssue.identifier);
    expect(state).toMatchObject({
      phase: "completed",
      terminalState: "Done",
      terminalReason: "startup recovery: Linear state is Done",
      terminalAt: expect.any(String)
    });
    const inspected = await runStore.inspect(completedRun.runId);
    const terminalAt = state?.terminalAt;
    for (const phase of ["human-wait", "needs-input", "ci-wait"]) {
      expect(inspected.summary.timing?.phases.find((entry) => entry.phase === phase)).toEqual(
        expect.objectContaining({
          status: "completed",
          finishedAt: terminalAt,
          metadata: expect.objectContaining({
            reason: "startup recovery: Linear state is Done",
            terminalState: "Done"
          })
        })
      );
    }
    const finishedWaitPhases = (await runStore.replay(completedRun.runId))
      .filter((event) => event.type === "phase_finished")
      .map((event) => (event.payload as { timing?: { phase?: string } }).timing?.phase)
      .filter((phase) => phase === "human-wait" || phase === "needs-input" || phase === "ci-wait")
      .sort();
    expect(finishedWaitPhases).toEqual(["ci-wait", "human-wait", "needs-input"]);
  });

  it("clears stale retries for already-merged pull requests instead of redispatching implementation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-already-merged-retry-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  terminal_states: [Done, Canceled, Duplicate]\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const waitRunStore = new RunArtifactStore(repo);
    const waitRun = await waitRunStore.startRun({ issue: readyIssue, attempt: null });
    await waitRunStore.startPhase(waitRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await waitRunStore.startPhase(waitRun.runId, {
      phase: "needs-input",
      status: "waiting",
      startedAt: "2026-01-01T00:05:00.000Z",
      label: "needs-input pause started"
    });
    await waitRunStore.startPhase(waitRun.runId, {
      phase: "ci-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:10:00.000Z",
      label: "ci wait started"
    });
    await waitRunStore.completeRun(waitRun.runId, { status: "succeeded" });
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        phase: "streaming-turn",
        lastRunId: waitRun.runId,
        reviewStatus: "human_required",
        lastError: "stale reviewer failure",
        errorCategory: "review",
        retryAttempt: 2,
        headSha: "stale-head",
        lastReviewedSha: "stale-reviewed",
        lastFixedSha: "stale-fixed",
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        nextRetryAt: "2026-01-01T00:00:00.000Z",
        validation: {
          status: "passed",
          checkedAt: "2026-01-01T00:00:00.000Z",
          githubCi: { status: "failed", headSha: "stale-ci", checkedAt: "2026-01-01T00:00:00.000Z" }
        },
        workspaceMissingAt: "2026-01-01T00:00:00.000Z",
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "MERGED",
          mergedAt: "2026-05-05T08:00:00Z",
          headRefOid: "merged-head-sha",
          headRefName: "agent/AG-1",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    const retryRunStore = new RunArtifactStore(repo);
    const retryRun = await retryRunStore.startRun({ issue: readyIssue, attempt: 1 });
    await retryRunStore.startPhase(retryRun.runId, {
      phase: "retry-backoff",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "retry backoff scheduled"
    });
    await retryRunStore.completeRun(retryRun.runId, { status: "failed", error: "stale retry" });
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: readyIssue.id,
      identifier: readyIssue.identifier,
      issue: readyIssue,
      attempt: 1,
      dueAt: "2026-01-01T00:00:00.000Z",
      error: "stale retry",
      scheduledAt: "2026-01-01T00:00:00.000Z",
      runId: retryRun.runId
    });
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Ready") ? [readyIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment() {}
    };
    let runnerCalled = false;

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(runnerCalled).toBe(false);
    expect(moves).toContain("AG-1 -> Done");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "completed",
      lifecycleStatus: "already_merged_pr",
      headSha: "merged-head-sha",
      lastReviewedSha: "merged-head-sha",
      lastFixedSha: "merged-head-sha",
      validation: expect.objectContaining({
        githubCi: expect.objectContaining({ status: "passed", headSha: "merged-head-sha" })
      })
    });
    expect(state.reviewStatus).toBeUndefined();
    expect(state.lastError).toBeUndefined();
    expect(state.errorCategory).toBeUndefined();
    expect(state.retryAttempt).toBeUndefined();
    expect(state.workspaceMissingAt).toBeUndefined();
    expect(state.nextRetryAt).toBeUndefined();
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.retryQueue).toEqual([]);
    const retryRunSummary = await retryRunStore.inspect(retryRun.runId);
    expect(retryRunSummary.summary.timing?.phases.find((phase) => phase.phase === "retry-backoff")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: expect.any(String),
        metadata: expect.objectContaining({ reason: "startup recovery: recorded pull request is already merged" })
      })
    );
    const retryRunEvents = await retryRunStore.replay(retryRun.runId);
    expect(retryRunEvents.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "retry-backoff")).toBe(true);
    const waitRunSummary = await waitRunStore.inspect(waitRun.runId);
    for (const phase of ["human-wait", "needs-input", "ci-wait"]) {
      expect(waitRunSummary.summary.timing?.phases.find((entry) => entry.phase === phase)).toEqual(
        expect.objectContaining({
          status: "completed",
          finishedAt: state.terminalAt,
          metadata: expect.objectContaining({
            reason: "startup recovery: recorded pull request is already merged",
            terminalState: "Done"
          })
        })
      );
    }
    const waitRunEvents = await waitRunStore.replay(waitRun.runId);
    const finishedWaitPhases = waitRunEvents
      .filter((event) => event.type === "phase_finished")
      .map((event) => (event.payload as { timing?: { phase?: string } }).timing?.phase)
      .filter((phase) => phase === "human-wait" || phase === "needs-input" || phase === "ci-wait")
      .sort();
    expect(finishedWaitPhases).toEqual(["ci-wait", "human-wait", "needs-input"]);
  });

  it("does not treat merged review-only PRs as terminal already-merged truth", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-only-merged-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  terminal_states: [Done, Canceled, Duplicate]\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        phase: "streaming-turn",
        prs: [{ url: "https://github.com/o/r/pull/2", source: "handoff", role: "do-not-merge", discoveredAt: new Date().toISOString() }],
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/2",
          state: "MERGED",
          mergedAt: "2026-05-05T08:00:00Z",
          headRefName: "agent/AG-1-review-only",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment() {}
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).not.toContain("AG-1 -> Done");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.lifecycleStatus).not.toBe("already_merged_pr");
  });

  it("does not orphan a run when Linear becomes Done before the first turn starts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-dispatch-race-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  terminal_states: [Done]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const doneIssue = { ...readyIssue, state: "Done", updated_at: "2026-01-03T00:00:00.000Z" };
    let stateFetches = 0;
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Ready") ? [readyIssue] : [];
      },
      async fetchIssueStates() {
        stateFetches += 1;
        return new Map([[readyIssue.id, stateFetches === 1 ? readyIssue : doneIssue]]);
      },
      async comment() {},
      async move() {}
    };
    let runnerCalled = false;

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(runnerCalled).toBe(false);
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary).toMatchObject({
      status: "canceled",
      error: "issue_became_terminal:Done"
    });
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.phase).toBe("completed");
    expect(state.nextRetryAt).toBeUndefined();
  });

  it("escalates stale review runs on startup instead of rerunning implementation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-stale-review-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready, In Progress]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    const inProgress = { ...readyIssue, state: "In Progress", updated_at: "2026-01-03T00:00:00.000Z" };
    const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(workspacePath, { recursive: true });
    const run = await new RunArtifactStore(repo).startRun({ issue: inProgress, attempt: null, workspace: { path: workspacePath, workspaceKey: "AG-1", createdNow: true } });
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        phase: "review",
        reviewStatus: "pending",
        lastRunId: run.runId,
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await new RuntimeStateStore(repo).upsertActiveRun({
      issueId: inProgress.id,
      identifier: inProgress.identifier,
      issue: inProgress,
      attempt: null,
      runId: run.runId,
      startedAt: run.startedAt,
      phase: "review",
      workspacePath,
      workspaceKey: "AG-1"
    });
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map([[inProgress.id, inProgress]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment() {}
    };
    let runnerCalled = false;

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "human-required",
      reviewStatus: "human_required",
      lifecycleStatus: "review_escalation"
    });
    expect((await new RunArtifactStore(repo).inspect(run.runId)).summary.status).toBe("stale");
  });

  it("reports daemon freshness when main advances under a long-running orchestrator", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-freshness-"));
    await run("git", ["init", "-b", "main"], repo);
    await run("git", ["config", "user.email", "agentos@example.test"], repo);
    await run("git", ["config", "user.name", "AgentOS Test"], repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(join(repo, "README.md"), "initial\n", "utf8");
    await run("git", ["add", "WORKFLOW.md", "README.md"], repo);
    await run("git", ["commit", "-m", "initial"], repo);
    const logger = new JsonlLogger(repo);
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map();
      }
    };
    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);
    await writeFile(join(repo, "README.md"), "advanced\n", "utf8");
    await run("git", ["add", "README.md"], repo);
    await run("git", ["commit", "-m", "advance main"], repo);
    await orchestrator.runOnce(true);

    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "daemon_freshness_warning" && entry.message?.includes("main advanced"))).toBe(true);
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.daemon?.freshnessStatus).toBe("main_advanced");
    expect(runtime.daemon?.workflowPath).toBe(workflowPath);
  });

  it("rebuilds and dispatches stale active implementation runs for active issues", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-stale-active-retry-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\nagent:\n  max_turns: 1\n  max_retry_attempts: 2\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nAttempt {{ attempt | default: 0 }} for {{ issue.identifier }}`,
      "utf8"
    );
    const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(workspacePath, { recursive: true });
    const run = await new RunArtifactStore(repo).startRun({ issue: readyIssue, attempt: null, workspace: { path: workspacePath, workspaceKey: "AG-1", createdNow: true } });
    await new RuntimeStateStore(repo).upsertActiveRun({
      issueId: readyIssue.id,
      identifier: readyIssue.identifier,
      issue: readyIssue,
      attempt: null,
      runId: run.runId,
      startedAt: run.startedAt,
      phase: "streaming-turn",
      workspacePath,
      workspaceKey: "AG-1"
    });
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async comment(_issue, body) {
        comments.push(body);
      },
      async move() {}
    };
    const prompts: string[] = [];

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          prompts.push(input.prompt);
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const staleRun = await new RunArtifactStore(repo).inspect(run.runId);
    expect(staleRun.summary.status).toBe("stale");
    expect(staleRun.summary.timing?.phases.find((phase) => phase.phase === "retry-backoff")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: expect.any(String),
        metadata: expect.objectContaining({ runId: run.runId, reason: "retry dispatched" })
      })
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Attempt 1 for AG-1");
    expect(comments.some((body) => body.includes("AgentOS retry scheduled"))).toBe(true);
  });

  it("releases stale workspace locks during startup recovery and reports them", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-lock-recovery-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const lockPath = join(repo, ".agent-os", "workspaces", ".agent-os", "locks", "workspaces", "AG-1.lock");
    await mkdir(lockPath, { recursive: true });
    const logger = new JsonlLogger(repo);
    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker: {
        async fetchCandidates() {
          return [];
        },
        async fetchIssueStates() {
          return new Map();
        }
      },
      runner: {
        async run(): Promise<AgentRunResult> {
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    await expect(access(lockPath)).rejects.toThrow();
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.lastRecovery?.locksReleased).toBe(1);
    expect(runtime.lastRecovery?.messages.some((message) => message.includes("released stale workspace lock AG-1"))).toBe(true);
    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "startup_recovery" && entry.message?.includes("released stale workspace lock AG-1"))).toBe(true);
  });

  it("does not mark active runs stale while Codex events are still arriving", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-active-stall-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\nagent:\n  max_turns: 1\n  max_retry_attempts: 1\nworkspace:\n  root: .agent-os/workspaces\ncodex:\n  stall_timeout_ms: 250\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    let runnerStarted = false;
    let aborted = false;
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    let eventCount = 0;
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async comment() {},
      async move() {}
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        runnerStarted = true;
        const emitActivity = () => {
          eventCount += 1;
          input.onEvent({
            type: "item/commandExecution/outputDelta",
            issueId: input.issue.id,
            issueIdentifier: input.issue.identifier,
            timestamp: new Date().toISOString()
          });
        };
        const eventTimer = setInterval(emitActivity, 5);
        emitActivity();
        return new Promise<AgentRunResult>((resolve) => {
          let finishTimer: NodeJS.Timeout;
          const abort = () => {
            aborted = true;
            clearInterval(eventTimer);
            clearTimeout(finishTimer);
            resolveFinished();
            resolve({ status: "canceled", error: "canceled" });
          };
          finishTimer = setTimeout(async () => {
            input.signal?.removeEventListener("abort", abort);
            clearInterval(eventTimer);
            await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
            resolveFinished();
            resolve({ status: "succeeded" });
          }, 80);
          input.signal?.addEventListener("abort", abort, { once: true });
        });
      }
    };
    const logger = new JsonlLogger(repo);
    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(false);
    await waitUntil(() => runnerStarted);
    await waitUntil(() => eventCount > 1);
    await orchestrator.runOnce(false);
    expect(aborted).toBe(false);
    await finished;

    const logs = await logger.tail(50);
    expect(logs.some((entry) => entry.type === "run_stalled")).toBe(false);
  });

  it("marks running attempts stale when no Codex events arrive before the stall timeout", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-inactive-stall-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\nagent:\n  max_turns: 1\n  max_retry_attempts: 1\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\ncodex:\n  stall_timeout_ms: 20\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    let aborted = false;
    let runnerStarted = false;
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async comment() {},
      async move() {}
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        runnerStarted = true;
        return new Promise<AgentRunResult>((resolve) => {
          if (input.signal?.aborted) {
            aborted = true;
            resolveFinished();
            resolve({ status: "canceled", error: "canceled" });
            return;
          }
          input.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolveFinished();
              resolve({ status: "canceled", error: "canceled" });
            },
            { once: true }
          );
        });
      }
    };
    const logger = new JsonlLogger(repo);
    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(false);
    await waitUntil(() => runnerStarted);
    await sleep(35);
    await orchestrator.runOnce(false);
    await finished;

    expect(aborted).toBe(true);
    const logs = await logger.tail(50);
    expect(logs.some((entry) => entry.type === "run_stalled" && entry.message === "stall timeout exceeded")).toBe(true);
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.timing?.phases.find((phase) => phase.phase === "stall-cancel")).toEqual(
      expect.objectContaining({
        status: "stalled",
        label: "stall timeout exceeded",
        metadata: expect.objectContaining({ stallTimeoutMs: 20 })
      })
    );
    const events = await new RunArtifactStore(repo).replay(summary.runId);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "stall-cancel")).toBe(true);
  });

  it("stops denied MCP elicitation requests for human input without retrying", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-elicitation-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\n  needs_input_state: Human Review\nagent:\n  max_turns: 1\n  max_retry_attempts: 3\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    let currentIssue = { ...readyIssue };
    const moves: string[] = [];
    const upserts: Array<{ issue: string; body: string; key: string }> = [];
    const tracker: IssueTracker = {
      async fetchCandidates(activeStates) {
        return activeStates.includes(currentIssue.state) ? [currentIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[currentIssue.id, currentIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
        currentIssue = { ...currentIssue, state };
      },
      async upsertComment(issue, body, key) {
        upserts.push({ issue, body, key });
      }
    };
    let runCount = 0;
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        runCount += 1;
        return { status: "failed", error: "codex_elicitation_request_denied", threadId: "thread-1", turnId: "turn-1" };
      }
    };
    const logger = new JsonlLogger(repo);
    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);
    await orchestrator.runOnce(true);

    expect(runCount).toBe(1);
    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(upserts.map((comment) => comment.key)).toContain("run_needs_input:AG-1");
    expect(upserts.find((comment) => comment.key === "run_needs_input:AG-1")?.body).toContain("Codex requested elicitation");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "needs-input",
      lastError: "codex_elicitation_request_denied",
      errorCategory: "human-input"
    });
    expect(state.nextRetryAt).toBeUndefined();
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary).toMatchObject({
      status: "failed",
      error: "codex_elicitation_request_denied"
    });
    const needsInputTiming = summary.timing?.phases.find((phase) => phase.phase === "needs-input");
    expect(needsInputTiming).toEqual(expect.objectContaining({ status: "waiting", label: "needs-input pause started" }));
    expect(needsInputTiming?.finishedAt).toBeUndefined();
    const events = await new RunArtifactStore(repo).replay(summary.runId);
    expect(events.some((event) => event.type === "run_needs_human_input" && event.message === "codex_elicitation_request_denied")).toBe(true);
    expect(events.some((event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "needs-input")).toBe(true);
    await expect(access(join(repo, ".agent-os", "workspaces", ".agent-os", "locks", "workspaces", "AG-1.lock"))).rejects.toThrow();
  });

  it("routes deterministic PR creation failures to Human Review without retrying", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-pr-create-failure-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\n  needs_input_state: Human Review\nagent:\n  max_turns: 1\n  max_retry_attempts: 3\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    const moves: string[] = [];
    const upserts: Array<{ body: string; key: string }> = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async upsertComment(_issue, body, key) {
        upserts.push({ body, key });
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        return { status: "failed", error: "agent_pr_creation_failed" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(upserts.find((comment) => comment.key === "run_needs_input:AG-1")?.body).toContain("agent_pr_creation_failed");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "needs-input",
      lastError: "agent_pr_creation_failed",
      errorCategory: "human-input"
    });
    expect(state.nextRetryAt).toBeUndefined();
  });

  it("continues successful turns up to max_turns until a handoff exists", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-max-turns-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nagent:\n  max_turns: 2\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const prompts: string[] = [];
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([["issue-1", readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment() {}
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompts.push(input.prompt);
        if (prompts.length === 2) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
        }
        return { status: "succeeded" };
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("AgentOS Continuation");
    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
  });

  it("does not move handoffs with failed validation evidence to Human Review", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-validation-failed-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\n  needs_input_state: Human Review\nagent:\n  max_turns: 1\n  max_retry_attempts: 1\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nAudit {{ issue.identifier }}`,
      "utf8"
    );

    const moves: string[] = [];
    const upserts: Array<{ body: string; key: string }> = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async upsertComment(_issue, body, key) {
        upserts.push({ body, key });
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        const runId = input.prompt.match(/^Run ID: (.+)$/m)?.[1] ?? "missing-run-id";
        await mkdir(join(input.workspace.path, ".agent-os", "validation"), { recursive: true });
        await writeFile(
          join(input.workspace.path, ".agent-os", "handoff-AG-1.md"),
          "AgentOS-Outcome: already-satisfied\nValidation-JSON: .agent-os/validation/AG-1.json",
          "utf8"
        );
        await writeValidationEvidence(join(input.workspace.path, ".agent-os", "validation", "AG-1.json"), {
          schemaVersion: 1,
          issueIdentifier: "AG-1",
          runId,
          status: "failed",
          commands: [
            {
              name: "npm run agent-check",
              exitCode: 1,
              startedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: "2026-01-01T00:00:01.000Z"
            }
          ]
        });
        return { status: "succeeded" };
      }
    };
    const logger = new JsonlLogger(repo);

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress"]);
    expect(upserts.find((comment) => comment.key === "retry_scheduled:AG-1")?.body).toContain("validation_failed");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "validation",
      errorCategory: "validation",
      validation: expect.objectContaining({ status: "failed" })
    });
    expect(state.nextRetryAt).toBeTruthy();
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary).toMatchObject({ status: "failed" });
    expect(summary.error).toContain("validation_failed");
    expect(summary.timing?.phases.find((phase) => phase.phase === "validation")).toEqual(
      expect.objectContaining({
        status: "failed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        metadata: expect.objectContaining({ timingSource: "commands" })
      })
    );
    expect(summary.timing?.phases.find((phase) => phase.phase === "retry-backoff")).toEqual(
      expect.objectContaining({
        status: "waiting",
        startedAt: expect.any(String),
        metadata: expect.objectContaining({ attempt: 1, runId: summary.runId, dueAt: expect.any(String) })
      })
    );
    expect(summary.timing?.phases.find((phase) => phase.phase === "retry-backoff")?.finishedAt).toBeUndefined();
    const events = await new RunArtifactStore(repo).replay(summary.runId);
    expect(events.some((event) => event.type === "validation_failed")).toBe(true);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "validation" && (event.payload as { timing?: { status?: string } }).timing?.status === "failed")).toBe(true);
    expect(events.some((event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "retry-backoff")).toBe(true);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "retry-backoff")).toBe(false);
    expect(events.some((event) => event.type === "run_succeeded")).toBe(false);
    const logs = await logger.tail(20);
    expect(logs.some((event) => event.type === "phase_timing" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "retry-backoff")).toBe(true);
  });

  it("closes retry backoff timing when a due retry is dispatched", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-retry-timing-close-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\nagent:\n  max_turns: 1\n  max_retry_attempts: 2\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment() {}
    };
    let runs = 0;
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        runs += 1;
        if (runs === 1) return { status: "failed", error: "transient runner failure" };
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
        return { status: "succeeded" };
      }
    };
    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);
    const store = new RunArtifactStore(repo);
    const [firstRun] = await store.listRuns();
    expect(firstRun.timing?.phases.find((phase) => phase.phase === "retry-backoff")?.status).toBe("waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
    await orchestrator.runOnce(true);

    expect(runs).toBe(2);
    const closed = await store.inspect(firstRun.runId);
    expect(closed.summary.timing?.phases.find((phase) => phase.phase === "retry-backoff")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: expect.any(String),
        durationMs: expect.any(Number),
        metadata: expect.objectContaining({ reason: "retry dispatched" })
      })
    );
    const events = await store.replay(firstRun.runId);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "retry-backoff" && (event.payload as { timing?: { status?: string } }).timing?.status === "completed")).toBe(true);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("closes retry backoff timing when a retry becomes due during candidate dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-retry-timing-candidate-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\nagent:\n  max_turns: 1\n  max_retry_attempts: 2\n  max_retry_backoff_ms: 1000\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nAttempt {{ attempt | default: 0 }} for {{ issue.identifier }}`,
      "utf8"
    );
    const retryRunStore = new RunArtifactStore(repo);
    const retryRun = await retryRunStore.startRun({ issue: readyIssue, attempt: 1 });
    await retryRunStore.startPhase(retryRun.runId, {
      phase: "retry-backoff",
      status: "waiting",
      startedAt: "1970-01-01T00:00:01.000Z",
      label: "retry backoff scheduled"
    });
    await retryRunStore.completeRun(retryRun.runId, { status: "failed", error: "pending retry" });
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: readyIssue.id,
      identifier: readyIssue.identifier,
      issue: readyIssue,
      attempt: 1,
      dueAt: "1970-01-01T00:00:02.000Z",
      error: "pending retry",
      scheduledAt: "1970-01-01T00:00:01.000Z",
      runId: retryRun.runId
    });

    let nowMs = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        nowMs = 2_000;
        return states.includes("Ready") ? [readyIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment() {}
    };
    let prompt = "";
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompt = input.prompt;
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
        return { status: "succeeded" };
      }
    };

    try {
      await new Orchestrator({
        repoRoot: repo,
        workflowPath,
        tracker,
        runner,
        logger: new JsonlLogger(repo),
        env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
      }).runOnce(true);
    } finally {
      dateNow.mockRestore();
    }

    expect(prompt).toContain("Attempt 1 for AG-1");
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.retryQueue).toEqual([]);
    const closed = await retryRunStore.inspect(retryRun.runId);
    expect(closed.summary.timing?.phases.find((phase) => phase.phase === "retry-backoff")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: expect.any(String),
        metadata: expect.objectContaining({ reason: "retry dispatched" })
      })
    );
    const events = await retryRunStore.replay(retryRun.runId);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "retry-backoff" && (event.payload as { timing?: { status?: string } }).timing?.status === "completed")).toBe(true);
  });

  it("cancels retry backoff timing when due candidate preparation clears a retry", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-retry-timing-candidate-skip-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\nagent:\n  max_turns: 1\n  max_retry_attempts: 2\n  max_retry_backoff_ms: 1000\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const retryRunStore = new RunArtifactStore(repo);
    const retryRun = await retryRunStore.startRun({ issue: readyIssue, attempt: 1 });
    await retryRunStore.startPhase(retryRun.runId, {
      phase: "retry-backoff",
      status: "waiting",
      startedAt: "1970-01-01T00:00:01.000Z",
      label: "retry backoff scheduled"
    });
    await retryRunStore.completeRun(retryRun.runId, { status: "failed", error: "pending retry" });
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: readyIssue.id,
      identifier: readyIssue.identifier,
      issue: readyIssue,
      attempt: 1,
      dueAt: "1970-01-01T00:00:02.000Z",
      error: "pending retry",
      scheduledAt: "1970-01-01T00:00:01.000Z",
      runId: retryRun.runId
    });

    let nowMs = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const inactiveIssue = { ...readyIssue, state: "Blocked" };
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        nowMs = 2_000;
        return states.includes("Ready") ? [readyIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, inactiveIssue]]);
      },
      async move() {},
      async comment() {}
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("retry should not dispatch");
      }
    };

    try {
      await new Orchestrator({
        repoRoot: repo,
        workflowPath,
        tracker,
        runner,
        logger: new JsonlLogger(repo),
        env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
      }).runOnce(true);
    } finally {
      dateNow.mockRestore();
    }

    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.retryQueue).toEqual([]);
    const closed = await retryRunStore.inspect(retryRun.runId);
    expect(closed.summary.timing?.phases.find((phase) => phase.phase === "retry-backoff")).toEqual(
      expect.objectContaining({
        status: "canceled",
        finishedAt: expect.any(String),
        metadata: expect.objectContaining({ reason: "retry skipped before dispatch" })
      })
    );
    const events = await retryRunStore.replay(retryRun.runId);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "retry-backoff" && (event.payload as { timing?: { status?: string } }).timing?.status === "canceled")).toBe(true);
  });

  it("fails and retries when max turns finish without a handoff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-missing-handoff-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nagent:\n  max_turns: 2\n  max_retry_attempts: 1\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const prompts: string[] = [];
    const moves: string[] = [];
    const upserts: Array<{ body: string; key: string }> = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async upsertComment(_issue, body, key) {
        upserts.push({ body, key });
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompts.push(input.prompt);
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(prompts).toHaveLength(2);
    expect(moves).toEqual(["AG-1 -> In Progress"]);
    expect(upserts.find((comment) => comment.key === "retry_scheduled:AG-1")?.body).toContain("missing_handoff");
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary).toMatchObject({ status: "failed", error: "missing_handoff" });
  });

  it("records already-satisfied no-op handoffs without requiring a PR", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-noop-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nAudit {{ issue.identifier }}`,
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        await writePassingHandoff(
          input.workspace.path,
          "AG-1",
          input.prompt,
          [
            "AgentOS-Outcome: already-satisfied",
            "",
            "### Implementation audit",
            "",
            "Acceptance criteria are already covered by the current codebase.",
            "",
            "Validation: npm run agent-check passed."
          ].join("\n")
        );
        return { status: "succeeded" };
      }
    };
    const logger = new JsonlLogger(repo);

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("already covered");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({ outcome: "already_satisfied" });
    expect(state.prUrl).toBeUndefined();
    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "issue_already_satisfied")).toBe(true);
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary).toMatchObject({ status: "succeeded" });
    expect((await new RunArtifactStore(repo).inspect(summary.runId)).warnings).toEqual([]);
  });

  it("records investigation-only implemented handoffs without requiring a PR", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-investigation-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nInvestigate {{ issue.identifier }}`,
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        await writePassingHandoff(
          input.workspace.path,
          "AG-1",
          input.prompt,
          [
            "AgentOS-Outcome: implemented",
            "",
            "### Summary",
            "",
            "Investigation completed; no repository changes or pull requests were needed.",
            "",
            "### Follow-Up Recommendations",
            "",
            "- File AG-2 if the optional cleanup becomes product work."
          ].join("\n")
        );
        return { status: "succeeded" };
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("Follow-Up Recommendations");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state).toMatchObject({ outcome: "implemented" });
    expect(state.prs).toBeUndefined();
    expect(state.prUrl).toBeUndefined();
    expect(state.reviewStatus).toBeUndefined();
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary).toMatchObject({ status: "succeeded" });
    expect((await new RunArtifactStore(repo).inspect(summary.runId)).warnings).toEqual([]);
  });

  it("persists multiple PR outputs without collapsing issue state to one PR", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-multi-pr-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        await writePassingHandoff(
          input.workspace.path,
          "AG-1",
          input.prompt,
          [
            "AgentOS-Outcome: implemented",
            "",
            "### Summary",
            "",
            "The issue was split into two reviewable PRs.",
            "",
            "PR: https://github.com/o/r/pull/1",
            "Follow-up PR: https://github.com/o/r/pull/2"
          ].join("\n")
        );
        return { status: "succeeded" };
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("Follow-up PR: https://github.com/o/r/pull/2");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.prs.map((pr: { url: string }) => pr.url)).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
    expect(state.prUrl).toBe("https://github.com/o/r/pull/1");
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary).toMatchObject({ status: "succeeded" });
    expect((await new RunArtifactStore(repo).inspect(summary.runId)).warnings).toEqual([]);
  });

  it("shepherds a mergeable PR from Merging to Done without running Codex", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const runStore = new RunArtifactStore(repo);
    const completedRun = await runStore.startRun({ issue: readyIssue, attempt: null });
    await runStore.startPhase(completedRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.startPhase(completedRun.runId, {
      phase: "ci-wait",
      status: "waiting",
      startedAt: "2026-01-02T00:00:00.000Z",
      label: "ci wait started"
    });
    await runStore.startPhase(completedRun.runId, {
      phase: "ci-wait",
      status: "waiting",
      startedAt: "2026-01-02T00:05:00.000Z",
      label: "ci wait started"
    });
    await runStore.completeRun(completedRun.runId, { status: "succeeded" });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        lastRunId: completedRun.runId,
        prUrl: "https://github.com/o/r/pull/1",
        prs: [
          { url: "https://github.com/o/r/pull/2", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() },
          { url: "https://github.com/o/r/pull/3", source: "handoff", role: "supporting", discoveredAt: new Date().toISOString() }
        ],
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/2",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          merged: false,
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for Merging issues");
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).toContain("Merged successfully");
    expect(comments.join("\n")).toContain("https://github.com/o/r/pull/2");
    const inspected = await runStore.inspect(completedRun.runId);
    expect(inspected.warnings).toEqual([]);
    expect(inspected.summary.timing?.phases.find((phase) => phase.phase === "human-wait")).toEqual(
      expect.objectContaining({
        status: "completed",
        label: "human review wait started",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: mergingIssue.updated_at,
        metadata: expect.objectContaining({ reason: "issue entered merge state" })
      })
    );
    const ciWaits = inspected.summary.timing?.phases.filter((phase) => phase.phase === "ci-wait") ?? [];
    expect(ciWaits).toHaveLength(2);
    expect(ciWaits[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        label: "ci wait started",
        finishedAt: expect.any(String),
        metadata: expect.objectContaining({ prUrl: "https://github.com/o/r/pull/2", reason: "checks ready" })
      })
    );
    expect(ciWaits[1]).toEqual(expect.objectContaining({ status: "completed", finishedAt: expect.any(String) }));
    const events = await runStore.replay(completedRun.runId);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "human-wait")).toBe(true);
    expect(events.filter((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "ci-wait")).toHaveLength(2);
  });

  it("does not fail merge shepherding when prior run timing artifacts are missing", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-missing-run-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        lastRunId: "run_20260101000000_AG-1_missing",
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        reviewStatus: "approved",
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const logger = new WarningWriteFailingLogger(repo);
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).toContain("Merged successfully");
    expect(comments.join("\n")).not.toContain("merge needs human review");
    const ghStateAfter = JSON.parse(await readFile(ghState, "utf8"));
    expect(ghStateAfter.mergedWith).toEqual(expect.arrayContaining(["--squash"]));
    expect(logger.warningAttempts).toBeGreaterThan(0);
    const logs = await logger.tail(50);
    expect(logs.some((entry) => entry.type === "merge_failed")).toBe(false);
  });

  it("treats an already-merged selected PR as Done without running Codex", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-already-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const staleMergeState = {
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      phase: "merge",
      prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff" as const, role: "primary" as const, discoveredAt: new Date().toISOString() }],
      reviewStatus: "human_required" as const,
      lastError: "stale reviewer failure",
      errorCategory: "review" as const,
      retryAttempt: 2,
      nextRetryAt: "2026-05-05T00:30:00.000Z",
      workspaceMissingAt: "2026-05-05T00:00:00.000Z",
      headSha: "stale-head",
      lastReviewedSha: "stale-reviewed",
      lastFixedSha: "stale-fixed",
      validation: {
        status: "passed" as const,
        checkedAt: "2026-05-05T00:00:00.000Z",
        githubCi: { status: "failed" as const, headSha: "stale-ci", checkedAt: "2026-05-05T00:00:00.000Z" }
      },
      updatedAt: new Date().toISOString()
    };
      await writeFile(
        ghState,
        JSON.stringify({
          view: {
            url: "https://github.com/o/r/pull/1",
            state: "MERGED",
            isDraft: false,
            mergeable: null,
            mergedAt: "2026-05-05T08:00:00Z",
            headRefOid: "merged-head-sha",
            headRefName: "agent/AG-1",
            statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
          }
        }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    let staleMergeStateWritten = false;
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        if (states.includes("Merging") && !staleMergeStateWritten) {
          staleMergeStateWritten = true;
          await writeFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), JSON.stringify(staleMergeState), "utf8");
        }
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[mergingIssue.id, mergingIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for already-merged PRs");
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).toContain("already merged");
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state).toMatchObject({
      phase: "completed",
      lifecycleStatus: "already_merged_pr",
      headSha: "merged-head-sha",
      lastReviewedSha: "merged-head-sha",
      lastFixedSha: "merged-head-sha",
      validation: expect.objectContaining({
        githubCi: expect.objectContaining({ status: "passed", headSha: "merged-head-sha" })
      })
    });
    expect(state?.reviewStatus).toBeUndefined();
    expect(state?.lastError).toBeUndefined();
    expect(state?.errorCategory).toBeUndefined();
    expect(state?.retryAttempt).toBeUndefined();
    expect(state?.nextRetryAt).toBeUndefined();
    expect(state?.workspaceMissingAt).toBeUndefined();
  });

  it("does not warn repeatedly when operator recovery records a run id without a summary artifact", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-recovery-summary-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  merge_mode: shepherd\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: readyIssue.id,
      issueIdentifier: readyIssue.identifier,
      phase: "completed",
      lastRunId: "run_operator_recovered",
      validation: {
        status: "passed",
        runId: "run_operator_recovered",
        checkedAt: "2026-05-17T02:00:00.000Z"
      },
      operatorRecovery: {
        recordedAt: "2026-05-17T02:00:00.000Z",
        branch: "agent/AG-1",
        headSha: "recovered-head",
        workspacePath: ".agent-os/workspaces/AG-1",
        handoffPath: ".agent-os/workspaces/AG-1/.agent-os/handoff-AG-1.md",
        proofArtifacts: []
      },
      updatedAt: "2026-05-17T02:00:00.000Z"
    });
    const logger = new JsonlLogger(repo);
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[mergingIssue.id, mergingIssue]]);
      },
      async move() {},
      async comment() {}
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const logs = await logger.tail(500);
    expect(logs.filter((entry) => entry.type === "phase_timing_persistence_warning")).toEqual([]);
  });

  it("keeps warning when non-recovery phase timing points at a missing run summary", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-missing-summary-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  merge_mode: shepherd\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: readyIssue.id,
      issueIdentifier: readyIssue.identifier,
      phase: "completed",
      lastRunId: "run_missing_summary",
      updatedAt: "2026-05-17T02:00:00.000Z"
    });
    const logger = new JsonlLogger(repo);
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[mergingIssue.id, mergingIssue]]);
      },
      async move() {},
      async comment() {}
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const warnings = (await logger.tail(500)).filter((entry) => entry.type === "phase_timing_persistence_warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.map((entry) => entry.message ?? "").join("\n")).toContain("summary.json");
  });

  it("records cleanup warnings instead of retrying when local branch deletion is blocked by an AgentOS worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-cleanup-"));
    await initGitRemote(repo);
    const pushRemote = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-cleanup-origin-"));
    await run("git", ["init", "--bare"], pushRemote);
    await run("git", ["remote", "set-url", "--push", "origin", pushRemote], repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(join(repo, "README.md"), "test\n", "utf8");
    await run("git", ["add", "README.md"], repo);
    await run("git", ["-c", "user.name=AgentOS", "-c", "user.email=agentos@example.com", "commit", "-m", "init"], repo);
    await run("git", ["branch", "agent/AG-1"], repo);
    const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(join(repo, ".agent-os", "workspaces"), { recursive: true });
    await run("git", ["worktree", "add", workspacePath, "agent/AG-1"], repo);
    const lockPath = join(repo, ".agent-os", "workspaces", ".agent-os", "locks", "workspaces", "AG-1.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ schemaVersion: 1, workspaceKey: "AG-1", workspacePath, pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8"
    );

    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\n  delete_branch: true\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        reviewStatus: "approved",
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefName: "agent/AG-1",
          headRepository: { name: "r", owner: { login: "o" } },
          headRepositoryOwner: { login: "o" },
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[mergingIssue.id, { ...mergingIssue, state: "Done" }]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for Merging issues");
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).toContain("Cleanup warnings");
    expect(comments.join("\n")).toContain("workspace_locked: AG-1");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.mergeCleanupWarnings.join("\n")).toContain("workspace_locked: AG-1");
    expect(state.mergeTargetUrl).toBe("https://github.com/o/r/pull/1");
    expect(moves).not.toContain("AG-1 -> Human Review");
  });

  it("moves approved no-PR handoffs from Merging to Done", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-no-pr-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const runStore = new RunArtifactStore(repo);
    const completedRun = await runStore.startRun({ issue: readyIssue, attempt: null });
    await runStore.startPhase(completedRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.completeRun(completedRun.runId, { status: "succeeded" });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        lastRunId: completedRun.runId,
        phase: "completed",
        outcome: "already_satisfied",
        validation: {
          status: "passed",
          finalStatus: "passed",
          acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }]
        },
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for no-PR Merging issues");
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).toContain("No merge-eligible pull request output was selected");
    expect(comments.join("\n")).toContain("approval of the handoff without a merge");
    const inspected = await runStore.inspect(completedRun.runId);
    expect(inspected.summary.timing?.phases.find((phase) => phase.phase === "human-wait")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: mergingIssue.updated_at,
        metadata: expect.objectContaining({ reason: "issue entered merge state" })
      })
    );
  });

  it("routes ambiguous merge-eligible PR metadata back to Human Review", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-ambiguous-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const runStore = new RunArtifactStore(repo);
    const completedRun = await runStore.startRun({ issue: readyIssue, attempt: null });
    await runStore.startPhase(completedRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.completeRun(completedRun.runId, { status: "succeeded" });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        lastRunId: completedRun.runId,
        phase: "completed",
        outcome: "implemented",
        reviewStatus: "approved",
        prs: [
          { url: "https://github.com/o/r/pull/2", source: "handoff", role: "docs", discoveredAt: new Date().toISOString() },
          { url: "https://github.com/o/r/pull/3", source: "handoff", role: "docs", discoveredAt: new Date().toISOString() }
        ],
        validation: {
          status: "passed",
          finalStatus: "passed",
          acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }]
        },
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for ambiguous Merging issues");
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("Multiple merge-eligible pull requests");
    expect(comments.join("\n")).toContain("select exactly one primary PR");
    const inspected = await runStore.inspect(completedRun.runId);
    expect(inspected.summary.timing?.phases.find((phase) => phase.phase === "human-wait")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: mergingIssue.updated_at,
        metadata: expect.objectContaining({ reason: "issue entered merge state" })
      })
    );
    const humanWaits = inspected.summary.timing?.phases.filter((phase) => phase.phase === "human-wait") ?? [];
    expect(humanWaits).toHaveLength(2);
    expect(humanWaits[1]).toEqual(
      expect.objectContaining({
        status: "waiting",
        label: "human review wait restarted",
        metadata: expect.objectContaining({
          reviewState: "Human Review",
          reason: expect.stringContaining("Multiple merge-eligible pull requests")
        })
      })
    );
  });

  it("rejects off-repository merge targets before invoking GitHub merge", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-off-repo-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        prs: [{ url: "https://github.com/other/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        reviewStatus: "approved",
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(ghState, JSON.stringify({}), "utf8");

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const ghStateAfter = JSON.parse(await readFile(ghState, "utf8"));
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("pull request URL must belong to current repository o/r");
    expect(ghStateAfter.mergedWith).toBeUndefined();
  });

  it("does not merge review-only PR roles from Merging", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-review-only-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        phase: "completed",
        outcome: "implemented",
        prs: [
          { url: "https://github.com/o/r/pull/2", source: "handoff", role: "supporting", discoveredAt: new Date().toISOString() },
          { url: "https://github.com/o/r/pull/3", source: "handoff", role: "do-not-merge", discoveredAt: new Date().toISOString() }
        ],
        validation: {
          status: "passed",
          finalStatus: "passed",
          acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" }]
        },
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for review-only Merging issues");
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).toContain("supporting");
    expect(comments.join("\n")).toContain("do-not-merge");
  });

  it("routes unsafe merge shepherd failures back to Human Review", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-fail-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({ issueId: "issue-1", issueIdentifier: "AG-1", prUrl: "https://github.com/o/r/pull/1", updatedAt: new Date().toISOString() }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          merged: false,
          statusCheckRollup: []
        }
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for Merging issues");
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("no GitHub checks are present");
  });

  it("keeps selected PRs with pending checks out of Done", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-pending-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const runStore = new RunArtifactStore(repo);
    const completedRun = await runStore.startRun({ issue: readyIssue, attempt: null });
    await runStore.startPhase(completedRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.completeRun(completedRun.runId, { status: "succeeded" });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        lastRunId: completedRun.runId,
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        reviewStatus: "approved",
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ name: "AgentOS CI", status: "IN_PROGRESS", conclusion: null }]
        }
      }),
      "utf8"
    );
    const moves: string[] = [];
    const comments: string[] = [];
    const logger = new JsonlLogger(repo);
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual([]);
    expect(comments.join("\n")).toContain("merge waiting");
    expect(comments.join("\n")).toContain("1 GitHub check(s) still pending");
    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "phase_timing" && (entry.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "ci-wait")).toBe(true);
    expect(logs.some((entry) => entry.type === "phase_timing" && (entry.payload as { timing?: { phase?: string; status?: string } }).timing?.phase === "merge-shepherding" && (entry.payload as { timing?: { status?: string } }).timing?.status === "waiting")).toBe(true);
    const inspected = await runStore.inspect(completedRun.runId);
    expect(inspected.warnings).toEqual([]);
    expect(inspected.summary.timing?.phases.find((phase) => phase.phase === "ci-wait")).toEqual(
      expect.objectContaining({
        status: "waiting",
        label: "ci wait started",
        metadata: expect.objectContaining({ prUrl: "https://github.com/o/r/pull/1" })
      })
    );
    expect(inspected.summary.timing?.phases.find((phase) => phase.phase === "merge-shepherding")).toEqual(
      expect.objectContaining({
        status: "waiting",
        label: "merge shepherding waiting on CI",
        metadata: expect.objectContaining({ prUrl: "https://github.com/o/r/pull/1" })
      })
    );
    const events = await runStore.replay(completedRun.runId);
    expect(events.some((event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "ci-wait")).toBe(true);
    expect(events.some((event) => event.type === "phase_finished" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "merge-shepherding")).toBe(true);
  });

  it("does not append duplicate ci waits across repeated pending merge passes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-pending-idempotent-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const runStore = new RunArtifactStore(repo);
    const completedRun = await runStore.startRun({ issue: readyIssue, attempt: null });
    await runStore.startPhase(completedRun.runId, {
      phase: "human-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "human review wait started"
    });
    await runStore.completeRun(completedRun.runId, { status: "succeeded" });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        lastRunId: completedRun.runId,
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        reviewStatus: "approved",
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ name: "AgentOS CI", status: "IN_PROGRESS", conclusion: null }]
        }
      }),
      "utf8"
    );
    let currentIssue = { ...mergingIssue };
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [currentIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async comment() {}
    };
    const runPendingPass = () =>
      new Orchestrator({
        repoRoot: repo,
        workflowPath,
        tracker,
        runner: {
          async run(): Promise<AgentRunResult> {
            throw new Error("runner should not be called for Merging issues");
          }
        },
        logger: new JsonlLogger(repo),
        env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
      }).runOnce(true);

    await runPendingPass();
    currentIssue = { ...mergingIssue, updated_at: "2026-01-02T00:05:00.000Z" };
    await runPendingPass();

    const inspected = await runStore.inspect(completedRun.runId);
    expect(inspected.summary.timing?.phases.find((phase) => phase.phase === "human-wait")).toEqual(
      expect.objectContaining({
        status: "completed",
        finishedAt: "2026-01-02T00:00:00.000Z",
        metadata: expect.objectContaining({ reason: "issue entered merge state" })
      })
    );
    const ciWaits = inspected.summary.timing?.phases.filter((phase) => phase.phase === "ci-wait") ?? [];
    expect(ciWaits).toHaveLength(1);
    expect(ciWaits[0]).toEqual(
      expect.objectContaining({
        status: "waiting",
        startedAt: "2026-01-02T00:00:00.000Z",
        metadata: expect.objectContaining({ reason: "1 GitHub check(s) still pending" })
      })
    );
    const ciWaitStarts = (await runStore.replay(completedRun.runId)).filter(
      (event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "ci-wait"
    );
    expect(ciWaitStarts).toHaveLength(1);
  });

  it("runs automated reviewers before moving an implemented PR to Human Review", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 1\n  required_reviewers: [self, correctness, tests, architecture]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      }),
      "utf8"
    );

    const moves: string[] = [];
    const comments: string[] = [];
    const reviewArtifactPrompts: string[] = [];
    const reviewPrompts: string[] = [];
    const reviewSandboxPolicies: unknown[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([["issue-1", readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          const runId = input.prompt.match(/Run ID: (run_[A-Za-z0-9._-]+)/)?.[1];
          expect(runId).toBeTruthy();
          await mkdir(join(input.workspace.path, ".agent-os"), { recursive: true });
          await writeFile(
            join(input.workspace.path, ".agent-os", "handoff-AG-1.md"),
            [
              "AgentOS-Outcome: implemented",
              "",
              "Primary PR: https://github.com/o/r/pull/1",
              "Docs PR: https://github.com/o/r/pull/2",
              "Supporting PR: https://github.com/o/r/pull/3",
              "",
              "Validation-JSON: .agent-os/validation/AG-1.json"
            ].join("\n"),
            "utf8"
          );
          const now = new Date().toISOString();
          await writeValidationEvidence(join(input.workspace.path, ".agent-os", "validation", "AG-1.json"), {
            schemaVersion: 1,
            issueIdentifier: "AG-1",
            runId,
            status: "passed",
            commands: [{ name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }]
          });
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        reviewPrompts.push(input.prompt);
        reviewArtifactPrompts.push(artifactPath);
        reviewSandboxPolicies.push(input.config.codex.turnSandboxPolicy);
        const reviewer = input.prompt.match(/You are the (.+) automated reviewer/)?.[1] ?? "self";
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer,
          decision: "approved",
          ...reviewArtifactScope(input),
          summary: "approved",
          findings: []
        });
        return { status: "succeeded" };
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("automated review approved");
    expect(comments.join("\n")).toContain("Review target mode: merge-eligible");
    expect(reviewPrompts[0]).toContain("https://github.com/o/r/pull/1, https://github.com/o/r/pull/2");
    expect(reviewPrompts[0]).toContain("Pack kind: reviewer");
    expect(reviewPrompts[0]).not.toContain("https://github.com/o/r/pull/3");
    expect(reviewArtifactPrompts).toHaveLength(4);
    expect(reviewArtifactPrompts.every((path) => path.startsWith(join(".agent-os", "reviews", "AG-1", "iteration-1")))).toBe(true);
    expect(reviewArtifactPrompts.every((path) => !path.includes(repo))).toBe(true);
    for (const policy of reviewSandboxPolicies) {
      expect(policy).toEqual({
        type: "workspaceWrite",
        writableRoots: [join(repo, ".agent-os", "workspaces", "AG-1", ".agent-os", "reviews", "AG-1", "iteration-1")],
        networkAccess: false
      });
    }
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewTargetUrls).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.timing?.phases.find((phase) => phase.phase === "automated-review")).toEqual(
      expect.objectContaining({
        status: "completed",
        metadata: expect.objectContaining({ reviewStatus: "approved", reviewIteration: 1 })
      })
    );
  });

  it("does not record automated review timing for handoffs without pull requests", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-no-pr-timing-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: true\n  max_iterations: 1\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented");
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.timing?.phases.some((phase) => phase.phase === "automated-review")).toBe(false);
    expect(comments.join("\n")).not.toContain("AgentOS automated review started");
  });

  it("marks automated review timing failed when review exits through an exception while pending", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-throws-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 1\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/example.ts" }]
        }
      }),
      "utf8"
    );
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      }
    };
    let runs = 0;
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        runs += 1;
        if (runs === 1) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, ["AgentOS-Outcome: implemented", "Primary PR: https://github.com/o/r/pull/1"].join("\n"));
          return { status: "succeeded" };
        }
        throw new Error("review runner exploded");
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.status).toBe("failed");
    expect(summary.timing?.phases.find((phase) => phase.phase === "automated-review")).toEqual(
      expect.objectContaining({
        status: "failed",
        metadata: expect.objectContaining({ reviewStatus: "pending", reviewExit: "error" })
      })
    );
  });

  it("records human_required when PR metadata has no selected review target", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-no-target-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: true\n  max_iterations: 1\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );

    let reviewRuns = 0;
    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nSupporting PR: https://github.com/o/r/pull/2");
          return { status: "succeeded" };
        }
        reviewRuns += 1;
        return { status: "failed", error: "review should not run without a selected target" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(reviewRuns).toBe(0);
    expect(moves).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("could not select a pull request target");
    expect(comments.join("\n")).toContain("review.target_mode=merge-eligible requires at least one primary or docs PR");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.reviewTargetUrls).toEqual([]);
    expect(state.lastError).toContain("no merge-eligible PR was recorded");
  });

  it("runs a focused fixer turn and recomputes review targets from the updated handoff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-fix-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 2\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    const reviewPrompts: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          const state = JSON.parse(await readFile(ghState, "utf8"));
          state.view.url = "https://github.com/o/r/pull/2";
          state.view.headRefOid = "def456";
          await writeFile(ghState, `${JSON.stringify(state, null, 2)}\n`, "utf8");
          await writePassingHandoff(
            input.workspace.path,
            "AG-1",
            input.prompt,
            ["AgentOS-Outcome: implemented", "", "Do not merge PR: https://github.com/o/r/pull/1", "Primary PR: https://github.com/o/r/pull/2"].join("\n")
          );
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        const iteration = Number(input.prompt.match(/Iteration: (\d+)/)?.[1] ?? "1");
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        reviewPrompts.push(input.prompt);
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: iteration === 1 ? "changes_requested" : "approved",
          ...reviewArtifactScope(input),
          summary: iteration === 1 ? "fix required" : "approved",
          findings:
            iteration === 1
              ? [
                  {
                    reviewer: "self",
                    decision: "changes_requested",
                    severity: "P1",
                    file: "src/orchestrator.ts",
                    line: 12,
                    body: "The retry-state branch has a deterministic off-by-one error.",
                    findingHash: "mechanical-review-finding"
                  }
                ]
              : []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(1);
    expect(comments.join("\n")).toContain("automated review requested fixes");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewIteration).toBe(2);
    expect(state.reviewTargetUrls).toEqual(["https://github.com/o/r/pull/2"]);
    expect(state.prs.map((pr: { url: string; role: string }) => [pr.url, pr.role])).toEqual([
      ["https://github.com/o/r/pull/1", "do-not-merge"],
      ["https://github.com/o/r/pull/2", "primary"]
    ]);
    expect(reviewPrompts[0]).toContain("- PR: https://github.com/o/r/pull/1");
    expect(reviewPrompts[1]).toContain("- PR: https://github.com/o/r/pull/2");
    expect(reviewPrompts[1]).not.toContain("- PR: https://github.com/o/r/pull/1");
    const [summary] = await new RunArtifactStore(repo).listRuns();
    expect(summary.timing?.phases.find((phase) => phase.phase === "fixer-turn")).toEqual(
      expect.objectContaining({
        status: "completed",
        metadata: expect.objectContaining({ iteration: 1, resultStatus: "succeeded" })
      })
    );
  });

  it("rejects off-repository PR metadata from focused fixer handoffs before state merge", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-fix-off-repo-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 2\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      }),
      "utf8"
    );

    let reviewRuns = 0;
    let fixRuns = 0;
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPrimary PR: https://github.com/other/r/pull/2");
          return { status: "succeeded" };
        }
        reviewRuns += 1;
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        const iteration = Number(input.prompt.match(/Iteration: (\d+)/)?.[1] ?? "1");
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: iteration === 1 ? "changes_requested" : "approved",
          ...reviewArtifactScope(input),
          summary: iteration === 1 ? "fix required" : "approved",
          findings:
            iteration === 1
              ? [
                  {
                    reviewer: "self",
                    decision: "changes_requested",
                    severity: "P1",
                    file: "src/orchestrator.ts",
                    line: 12,
                    body: "The primary PR role must be updated.",
                    findingHash: "mechanical-review-finding"
                  }
                ]
              : []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(1);
    expect(reviewRuns).toBe(1);
    expect(comments.join("\n")).toContain("focused fixer handoff contained pull request metadata");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.lastError).toContain("pull request URL must belong to current repository o/r");
    expect(state.prs.map((pr: { url: string }) => pr.url)).toEqual(["https://github.com/o/r/pull/1"]);
    expect(state.findings[0].reviewer).toBe("handoff");
  });

  it("escalates repeated blocking review findings to human_required", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-repeated-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 3\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: "changes_requested",
          ...reviewArtifactScope(input),
          summary: "same finding",
          findings: [
            {
              reviewer: "self",
              decision: "changes_requested",
              severity: "P1",
              file: "src/orchestrator.ts",
              line: 12,
              body: "The same deterministic off-by-one error is still present.",
              findingHash: "same-review-finding"
            }
          ]
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(1);
    expect(comments.join("\n")).toContain("same blocking finding repeated after a fix");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.reviewIteration).toBe(2);
  });

  it("recommends split work for repeated broad architecture findings", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-budget-arch-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 3\n  required_reviewers: [architecture]\n  optional_reviewers: []\n  budget:\n    repeated_broad_category_threshold: 2\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        const iteration = Number(input.prompt.match(/Iteration: (\d+)/)?.[1] ?? "1");
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "architecture",
          decision: "changes_requested",
          ...reviewArtifactScope(input),
          summary: "broad architecture",
          findings: [
            {
              reviewer: "architecture",
              decision: "changes_requested",
              severity: "P2",
              file: "src/orchestrator.ts",
              line: 1,
              body: "Architecture and lifecycle scope is too broad for another cheap fixer turn.",
              findingHash: `architecture-broad-${iteration}`
            }
          ]
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(1);
    expect(comments.join("\n")).toContain("review budget recommends split/follow-up");
    expect(comments.join("\n")).toContain("repeated_broad_categories");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.splitRecommendation.reason).toContain("review budget exceeded");
  }, 15000);

  it("prepares a follow-up proposal when changed-file budget is exceeded", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-budget-proposal-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 2\n  required_reviewers: [self]\n  optional_reviewers: []\n  budget:\n    mode: prepare-draft\n    max_changed_files: 1\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/a.ts" }, { path: "src/b.ts" }]
        }
      }),
      "utf8"
    );

    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment() {}
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: "approved",
          ...reviewArtifactScope(input),
          summary: "approved",
          findings: []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.splitRecommendation.proposals[0].artifactPath).toBe(".agent-os/follow-ups/AG-1-review-budget.md");
    await expect(readFile(join(repo, ".agent-os", "follow-ups", "AG-1-review-budget.md"), "utf8")).resolves.toContain("Parent issue: AG-1");
  });

  it("refreshes fixer validation evidence before evaluating review rerun budget", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-budget-validation-refresh-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 2\n  required_reviewers: [self]\n  optional_reviewers: []\n  budget:\n    max_validation_reruns: 0\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment() {}
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          const validationPath = ".agent-os/validation/AG-1.json";
          const runId = input.prompt.match(/^Run ID: (.+)$/m)?.[1] ?? "missing-run-id";
          const failedStartedAt = new Date(Date.now() - 180_000).toISOString();
          const failedFinishedAt = new Date(Date.now() - 120_000).toISOString();
          const passedStartedAt = new Date(Date.now() - 60_000).toISOString();
          const passedFinishedAt = new Date(Date.now() - 1000).toISOString();
          await mkdir(join(input.workspace.path, ".agent-os", "validation"), { recursive: true });
          await writeFile(join(input.workspace.path, ".agent-os", "handoff-AG-1.md"), `AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1\n\nValidation-JSON: ${validationPath}`, "utf8");
          await writeValidationEvidence(join(input.workspace.path, validationPath), {
            schemaVersion: 1,
            issueIdentifier: "AG-1",
            runId,
            status: "passed",
            finalResult: { status: "passed", command: "npm run agent-check", exitCode: 0, startedAt: passedStartedAt, finishedAt: passedFinishedAt },
            commands: [
              { name: "npm run agent-check", exitCode: 1, startedAt: failedStartedAt, finishedAt: failedFinishedAt },
              { name: "npm run agent-check", exitCode: 0, startedAt: passedStartedAt, finishedAt: passedFinishedAt }
            ]
          });
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        const iteration = Number(input.prompt.match(/Iteration: (\d+)/)?.[1] ?? "1");
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: iteration === 1 ? "changes_requested" : "approved",
          ...reviewArtifactScope(input),
          summary: iteration === 1 ? "fix required" : "approved",
          findings:
            iteration === 1
              ? [
                  {
                    reviewer: "self",
                    decision: "changes_requested",
                    severity: "P2",
                    file: "src/orchestrator.ts",
                    line: 1,
                    body: "Mechanical fix needed.",
                    findingHash: "mechanical-fix-needed"
                  }
                ]
              : []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(1);
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.validation.failedHistoricalAttempts).toHaveLength(1);
    expect(state.reviewStatus).toBe("human_required");
    expect(state.splitRecommendation.signals.map((signal: { name: string }) => signal.name)).toContain("validation_reruns");
  });

  it("runs a bounded CI fixer turn for mechanical failed checks with logs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-ci-mechanical-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\nautomation:\n  repair_policy: mechanical-first\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 2\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/123"
            }
          ],
          files: [{ path: "src/orchestrator.ts" }]
        },
        runLogs: {
          "123": "npm run agent-check\nsrc/orchestrator.ts(12,3): error TS2304: Cannot find name 'missingValue'."
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    let fixPromptText = "";
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment() {}
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          fixPromptText = input.prompt;
          const state = JSON.parse(await readFile(ghState, "utf8"));
          state.view.statusCheckRollup = [{ name: "AgentOS CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/o/r/actions/runs/124" }];
          state.runLogs = {};
          await writeFile(ghState, `${JSON.stringify(state, null, 2)}\n`, "utf8");
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: "approved",
          ...reviewArtifactScope(input),
          summary: "approved",
          findings: []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(1);
    expect(fixPromptText).toContain("AgentOS CI");
    expect(fixPromptText).toContain("Pack kind: ci-repair");
    expect(fixPromptText).toContain("TS2304");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewIteration).toBe(2);
    expect(state.splitRecommendation).toBeUndefined();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("escalates mechanical CI failures when trust mode cannot update the PR", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-ci-trust-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: ci-locked\nautomation:\n  repair_policy: mechanical-first\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 2\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/123"
            }
          ],
          files: [{ path: "src/orchestrator.ts" }]
        },
        runLogs: {
          "123": "npm run agent-check\nsrc/orchestrator.ts(12,3): error TS2304: Cannot find name 'missingValue'."
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: "approved",
          ...reviewArtifactScope(input),
          summary: "approved",
          findings: []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(0);
    expect(comments.join("\n")).toContain("trust_mode=ci-locked does not allow PR/network capability");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.findings[0].decision).toBe("human_required");
  });

  it("keeps using bounded CI fixer turns when the same check fails with different logs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-ci-changing-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\nautomation:\n  repair_policy: mechanical-first\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 3\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/123"
            }
          ],
          files: [{ path: "src/orchestrator.ts" }]
        },
        runLogs: {
          "123": "npm run agent-check\nsrc/orchestrator.ts(12,3): error TS2304: Cannot find name 'missingValue'."
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          const state = JSON.parse(await readFile(ghState, "utf8"));
          if (fixRuns === 1) {
            state.view.statusCheckRollup = [
              {
                name: "AgentOS CI",
                status: "COMPLETED",
                conclusion: "FAILURE",
                detailsUrl: "https://github.com/o/r/actions/runs/124"
              }
            ];
            state.runLogs = {
              "124": "npm test\nAssertionError: expected 1 to be 2"
            };
          } else {
            state.view.statusCheckRollup = [{ name: "AgentOS CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/o/r/actions/runs/125" }];
            state.runLogs = {};
          }
          await writeFile(ghState, `${JSON.stringify(state, null, 2)}\n`, "utf8");
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: "approved",
          ...reviewArtifactScope(input),
          summary: "approved",
          findings: []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(2);
    expect(comments.join("\n")).not.toContain("TS2304");
    expect(comments.join("\n")).not.toContain("AssertionError");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewIteration).toBe(3);
    expect(state.resolvedFindingHashes).toEqual(expect.arrayContaining([expect.stringContaining("checks-failing-mechanical-")]));
  }, 10_000);

  it("escalates failed checks without logs instead of running a CI fixer", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-ci-no-logs-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\nautomation:\n  repair_policy: mechanical-first\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 2\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/123"
            }
          ],
          files: [{ path: "src/orchestrator.ts" }]
        },
        runLogs: {
          "123": ""
        }
      }),
      "utf8"
    );

    let fixRuns = 0;
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
          return { status: "succeeded" };
        }
        if (input.prompt.startsWith("You are fixing")) {
          fixRuns += 1;
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer: "self",
          decision: "approved",
          ...reviewArtifactScope(input),
          summary: "approved",
          findings: []
        });
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(fixRuns).toBe(0);
    expect(comments.join("\n")).toContain("could not classify");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.findings[0].decision).toBe("human_required");
  });

  it("escalates malformed review artifacts to human_required", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-malformed-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: true\n  max_iterations: 1\n  required_reviewers: [self]\n  optional_reviewers: []\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      }),
      "utf8"
    );

    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([["issue-1", readyIssue]]);
      },
      async move() {},
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        if (input.prompt.startsWith("Do ")) {
          const runId = input.prompt.match(/Run ID: (run_[A-Za-z0-9._-]+)/)?.[1];
          expect(runId).toBeTruthy();
          await mkdir(join(input.workspace.path, ".agent-os"), { recursive: true });
          await writeFile(
            join(input.workspace.path, ".agent-os", "handoff-AG-1.md"),
            "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1\n\nValidation-JSON: .agent-os/validation/AG-1.json",
            "utf8"
          );
          const now = new Date().toISOString();
          await writeValidationEvidence(join(input.workspace.path, ".agent-os", "validation", "AG-1.json"), {
            schemaVersion: 1,
            issueIdentifier: "AG-1",
            runId,
            status: "passed",
            commands: [{ name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }]
          });
          return { status: "succeeded" };
        }
        const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
        if (!artifactPath) return { status: "failed", error: "missing artifact path" };
        await writeFile(join(input.workspace.path, artifactPath), "{ this is not json", "utf8");
        return { status: "succeeded" };
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(comments.join("\n")).toContain("automated review needs human judgment");
    expect(comments.join("\n")).toContain("Reviewer runner failures:");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.findings).toEqual([]);
    expect(state.reviewRunnerFailures.at(-1)).toEqual(expect.objectContaining({ reason: "malformed_artifact", exhausted: true }));
    const canonicalArtifact = JSON.parse(await readFile(join(repo, ".agent-os", "reviews", "AG-1", "iteration-1", "self.json"), "utf8"));
    expect(canonicalArtifact.decision).toBe("human_required");
    expect(canonicalArtifact.findings[0].body).toContain("invalid review JSON");
  });

  it("blocks unapproved merge state when human override is disabled", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-review-gate-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\n  allow_human_merge_override: false\nreview:\n  enabled: true\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        prUrl: "https://github.com/o/r/pull/1",
        reviewStatus: "changes_requested",
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    const runner: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        throw new Error("runner should not be called for Merging issues");
      }
    };

    const orchestrator = new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    });

    await orchestrator.runOnce(true);

    expect(moves).toEqual(["AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("automated review is not approved");
  });

  it("permits merge after authoritative split follow-up decision with fresh validation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-split-follow-up-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\n  allow_human_merge_override: false\nreview:\n  enabled: true\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: "2026-05-16T00:00:00.000Z" }],
          reviewStatus: "human_required",
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-16T00:05:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-16T00:04:00.000Z", finishedAt: "2026-05-16T00:05:00.000Z" }]
          },
          splitRecommendation: {
            recommended: true,
            action: "recommend-only",
            reason: "review budget exceeded for broad or non-mechanical signals",
            summary: "Recommend split or follow-up work for AG-1: repeated_broad_categories.",
            signals: [{ name: "repeated_broad_categories", classification: "broad", current: 2, threshold: 2, summary: "Repeated broad review categories: architecture." }],
            recordedAt: "2026-05-16T00:03:00.000Z"
          },
          humanDecisions: [
            {
              type: "split_follow_up",
              source: "linear-comment",
              trusted: true,
              actor: "Supervisor",
              actorId: "user-supervisor",
              actorEmail: "supervisor@example.com",
              commentId: "comment-split",
              decidedAt: "2026-05-16T00:06:00.000Z",
              validationEvidence: ".agent-os/validation/AG-1.json",
              ciState: "passed",
              findings: "accepted",
              summary: "follow-up issue linked and residual risk accepted"
            }
          ],
          lastHumanDecision: {
            type: "split_follow_up",
            source: "linear-comment",
            trusted: true,
            actor: "Supervisor",
            actorId: "user-supervisor",
            actorEmail: "supervisor@example.com",
            commentId: "comment-split",
            decidedAt: "2026-05-16T00:06:00.000Z",
            validationEvidence: ".agent-os/validation/AG-1.json",
            ciState: "passed",
            findings: "accepted",
            summary: "follow-up issue linked and residual risk accepted"
          },
          lifecycleStatus: "supervisor_continuation",
          updatedAt: "2026-05-16T00:06:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).not.toContain("split/follow-up recommendation is still open");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.mergedAt).toBeTruthy();
  });

  it("ingests newer split decisions when stored supervisor decisions predate split recommendations", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-stale-split-decision-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\n  allow_human_merge_override: false\nreview:\n  enabled: true\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: "2026-05-16T00:00:00.000Z" }],
          reviewStatus: "human_required",
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-16T00:05:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-16T00:04:00.000Z", finishedAt: "2026-05-16T00:05:00.000Z" }]
          },
          splitRecommendation: {
            recommended: true,
            action: "recommend-only",
            reason: "review budget exceeded for broad or non-mechanical signals",
            summary: "Recommend split or follow-up work for AG-1: repeated_broad_categories.",
            signals: [{ name: "repeated_broad_categories", classification: "broad", current: 2, threshold: 2, summary: "Repeated broad review categories: architecture." }],
            recordedAt: "2026-05-16T00:03:00.000Z"
          },
          humanDecisions: [
            {
              type: "approve_as_is",
              source: "linear-comment",
              trusted: true,
              actor: "Supervisor",
              actorId: "user-supervisor",
              actorEmail: "supervisor@example.com",
              commentId: "comment-old-approval",
              decidedAt: "2026-05-16T00:01:00.000Z",
              validationEvidence: ".agent-os/validation/AG-1.json",
              ciState: "passed",
              findings: "accepted",
              summary: "approved before later split signal"
            }
          ],
          lastHumanDecision: {
            type: "approve_as_is",
            source: "linear-comment",
            trusted: true,
            actor: "Supervisor",
            actorId: "user-supervisor",
            actorEmail: "supervisor@example.com",
            commentId: "comment-old-approval",
            decidedAt: "2026-05-16T00:01:00.000Z",
            validationEvidence: ".agent-os/validation/AG-1.json",
            ciState: "passed",
            findings: "accepted",
            summary: "approved before later split signal"
          },
          lifecycleStatus: "supervisor_continuation",
          updatedAt: "2026-05-16T00:03:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    const moves: string[] = [];
    const comments: string[] = [];
    let commentReads = 0;
    const issue = { ...mergingIssue, ...supervisorAssignee };
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [issue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async fetchIssueComments() {
        commentReads += 1;
        return [
          {
            id: "comment-fresh-split",
            ...supervisorCommentAuthor,
            createdAt: "2026-05-16T00:06:00.000Z",
            body: [
              "AgentOS-Human-Decision: split-follow-up",
              "Validation-JSON: .agent-os/validation/AG-1.json",
              "CI-State: passed",
              "Findings: accepted",
              "Decision-Summary: follow-up issue linked after the split signal"
            ].join("\n")
          }
        ];
      },
      async move(issueIdentifier, state) {
        moves.push(`${issueIdentifier} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(commentReads).toBe(1);
    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).not.toContain("split/follow-up recommendation is still open");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.lastHumanDecision.type).toBe("split_follow_up");
    expect(state.mergedAt).toBeTruthy();
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("records supervisor continuation and permits merge with fresh validation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-human-continue-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntrust_mode: local-trusted\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  merge_mode: shepherd\n  done_state: Done\n  allow_human_merge_override: true\nreview:\n  enabled: true\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        reviewStatus: "changes_requested",
        validation: {
          status: "passed",
          finalStatus: "passed",
          acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-05T00:00:00.000Z", finishedAt: "2026-05-05T00:01:00.000Z" }]
        },
        updatedAt: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Merging") ? [mergingIssue] : [];
      },
      async fetchIssueStates() {
        return new Map();
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("runner should not be called for Merging issues");
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(moves).toEqual(["AG-1 -> Done"]);
    expect(comments.join("\n")).toContain("review override recorded");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.humanContinuationAt).toBeTruthy();
    expect(state.humanOverrideAt).toBeTruthy();
    expect(state.mergedAt).toBeTruthy();
  });

  it("refuses Todo redispatch when an approved PR is already merge-ready", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-approved-redispatch-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: readyIssue.id,
        issueIdentifier: readyIssue.identifier,
        phase: "completed",
        reviewStatus: "approved",
        prs: [{ url: "https://github.com/o/r/pull/1", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
        humanDecisions: [
          {
            type: "fix_findings",
            source: "linear-comment",
            trusted: true,
            actor: "Supervisor",
            actorId: "user-supervisor",
            actorEmail: "supervisor@example.com",
            decidedAt: "2026-05-04T00:00:00.000Z",
            commentId: "comment-stale-fix",
            body: "AgentOS-Human-Decision: fix-findings"
          }
        ],
        lastHumanDecision: {
          type: "fix_findings",
          source: "linear-comment",
          trusted: true,
          actor: "Supervisor",
          actorId: "user-supervisor",
          actorEmail: "supervisor@example.com",
          decidedAt: "2026-05-04T00:00:00.000Z",
          commentId: "comment-stale-fix",
          body: "AgentOS-Human-Decision: fix-findings"
        },
        updatedAt: "2026-05-05T00:00:00.000Z"
      }),
      "utf8"
    );
    const todoIssue = { ...readyIssue, state: "Todo", updated_at: "2026-05-06T00:00:00.000Z" };
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Todo") ? [todoIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[todoIssue.id, todoIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment() {}
    };
    let runnerCalled = false;
    const logger = new JsonlLogger(repo);

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Merging"]);
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.phase).toBe("merge");
    expect(state.stopReason).toContain("approved PR is merge-ready");
    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "dispatch_skipped" && entry.message?.includes("approved PR is merge-ready"))).toBe(true);
  });

  it("rejects off-repository approved PR metadata before reading GitHub readiness during dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-approved-off-repo-dispatch-"));
    await initGitRemote(repo);
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await writeFile(
      ghState,
      JSON.stringify({
        view: {
          url: "https://github.com/other/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: readyIssue.id,
        issueIdentifier: readyIssue.identifier,
        phase: "completed",
        reviewStatus: "approved",
        prs: [{ url: "https://github.com/other/r/pull/1", role: "primary", source: "manual", discoveredAt: "2026-05-05T00:00:00.000Z" }],
        updatedAt: "2026-05-05T00:00:00.000Z"
      }),
      "utf8"
    );
    const todoIssue = { ...readyIssue, state: "Todo", updated_at: "2026-05-06T00:00:00.000Z" };
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Todo") ? [todoIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[todoIssue.id, todoIssue]]);
      },
      async fetchIssueComments() {
        return [];
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment() {}
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    const state = await new IssueStateStore(repo).read("AG-1");
    expect(state?.phase).toBe("human-required");
    expect(state?.reviewStatus).toBe("human_required");
    expect(state?.lastError).toContain("pull request URL must belong to current repository o/r");
  });

  it("redacts credentialed git remotes from dispatch PR target guardrail state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-approved-pr-secret-origin-"));
    const secret = "topsecret-token";
    await initGitRemote(repo, `https://${secret}@github.com/o/r.git`);
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Todo]\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    const statePath = join(repo, ".agent-os", "state", "issues", "AG-1.json");
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        issueId: readyIssue.id,
        issueIdentifier: readyIssue.identifier,
        phase: "completed",
        reviewStatus: "approved",
        prs: [{ url: "https://github.com/o/r/pull/1", role: "primary", source: "manual", discoveredAt: "2026-05-05T00:00:00.000Z" }],
        updatedAt: "2026-05-05T00:00:00.000Z"
      }),
      "utf8"
    );
    const todoIssue = { ...readyIssue, state: "Todo", updated_at: "2026-05-06T00:00:00.000Z" };
    const moves: string[] = [];
    const logger = new JsonlLogger(repo);
    const tracker: IssueTracker = {
      async fetchCandidates(states) {
        return states.includes("Todo") ? [todoIssue] : [];
      },
      async fetchIssueStates() {
        return new Map([[todoIssue.id, todoIssue]]);
      },
      async fetchIssueComments() {
        return [];
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    const serializedState = await readFile(statePath, "utf8");
    expect(serializedState).not.toContain(secret);
    const state = JSON.parse(serializedState);
    expect(state.lastError).toContain("unsupported_github_remote_origin");
    expect(state.lastError).toContain("[REDACTED]");
    expect(state.lastError.length).toBeLessThan(500);
    expect(JSON.stringify(await logger.tail(20))).not.toContain(secret);
  });

  it("refuses dispatch when a prepared active issue is now in Human Review", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-human-review-dispatch-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const humanReviewIssue = { ...readyIssue, state: "Human Review", updated_at: "2026-05-08T21:00:00.000Z" };
    let stateChecks = 0;
    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        stateChecks += 1;
        return new Map([[readyIssue.id, stateChecks === 1 ? readyIssue : humanReviewIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    let runnerCalled = false;
    const logger = new JsonlLogger(repo);

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual([]);
    expect(comments).toEqual([]);
    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "dispatch_skipped" && entry.message === "issue_no_longer_dispatchable:Human Review")).toBe(true);
  });

  it("does not move or comment when an issue reaches Human Review before start bookkeeping", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-human-review-start-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const humanReviewIssue = { ...readyIssue, state: "Human Review", updated_at: "2026-05-08T21:00:00.000Z" };
    let stateChecks = 0;
    const moves: string[] = [];
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        stateChecks += 1;
        return new Map([[readyIssue.id, stateChecks <= 3 ? readyIssue : humanReviewIssue]]);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      },
      async comment(_issue, body) {
        comments.push(body);
      }
    };
    let runnerCalled = false;
    const logger = new JsonlLogger(repo);

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(1);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual([]);
    expect(comments).toEqual([]);
    const logs = await logger.tail(20);
    expect(logs.some((entry) => entry.type === "linear_update_skipped" && entry.message?.includes("move to In Progress: refused because issue is in Human Review"))).toBe(true);
  });

  it("refuses fresh dispatch when a prior failed run left dirty recoverable workspace work", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-dirty-salvage-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(workspacePath, { recursive: true });
    await run("git", ["init", "-b", "main"], workspacePath);
    await run("git", ["config", "user.email", "agentos@example.test"], workspacePath);
    await run("git", ["config", "user.name", "AgentOS Test"], workspacePath);
    await writeFile(join(workspacePath, "README.md"), "initial\n", "utf8");
    await run("git", ["add", "README.md"], workspacePath);
    await run("git", ["commit", "-m", "initial"], workspacePath);
    await writeFile(join(workspacePath, "README.md"), "dirty local fix\n", "utf8");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  needs_input_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: readyIssue.id,
        issueIdentifier: readyIssue.identifier,
        phase: "needs-input",
        lifecycleStatus: "implementation_failure",
        lastError: "codex_stall_timeout",
        workspacePath,
        updatedAt: "2026-05-05T00:00:00.000Z"
      }),
      "utf8"
    );
    const comments: string[] = [];
    const moves: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async comment(_issue, body) {
        comments.push(body);
      },
      async move(issue, state) {
        moves.push(`${issue} -> ${state}`);
      }
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          runnerCalled = true;
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(runnerCalled).toBe(false);
    expect(moves).toEqual(["AG-1 -> Human Review"]);
    expect(comments.join("\n")).toContain("recoverable partial work");
    expect(comments.join("\n")).toContain("workspace has uncommitted changes");
    expect(comments.join("\n")).toContain(`resume ${workspacePath}`);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("does not treat a clean no-upstream branch at the base commit as recoverable partial work", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-clean-no-upstream-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    const workspacePath = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(workspacePath, { recursive: true });
    await initCleanWorkspaceAtOriginMain(workspacePath);
    await run("git", ["checkout", "-b", "agent/AG-1"], workspacePath);
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: readyIssue.id,
      issueIdentifier: readyIssue.identifier,
      phase: "needs-input",
      lifecycleStatus: "implementation_failure",
      lastError: "codex_read_timeout: initialize",
      workspacePath,
      updatedAt: "2026-05-15T06:33:41.000Z"
    });
    const comments: string[] = [];
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async comment(_issue, body) {
        comments.push(body);
      },
      async move() {}
    };
    let runnerCalled = false;

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          runnerCalled = true;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(1);
    expect(runnerCalled).toBe(true);
    expect(comments.join("\n")).not.toContain("recoverable partial work");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("injects existing implementation audit context for partially satisfied scope", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-partial-audit-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: readyIssue.id,
        issueIdentifier: readyIssue.identifier,
        outcome: "partially_satisfied",
        phase: "needs-input",
        updatedAt: "2026-05-05T00:00:00.000Z"
      }),
      "utf8"
    );
    let prompt = "";
    const tracker: IssueTracker = {
      async fetchCandidates() {
        return [readyIssue];
      },
      async fetchIssueStates() {
        return new Map([[readyIssue.id, readyIssue]]);
      },
      async comment() {},
      async move() {}
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(input): Promise<AgentRunResult> {
          prompt = input.prompt;
          await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
          return { status: "succeeded" };
        }
      },
      logger: new JsonlLogger(repo),
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    expect(prompt).toContain("## Existing Implementation Audit Requirement");
    expect(prompt).toContain("Recorded prior outcome: partially_satisfied");
    expect(prompt).toContain("Recorded phase: prompt");
    expect(prompt).toContain("continue from the existing artifacts");
  });
});

async function writePassingHandoff(
  workspacePath: string,
  issueIdentifier: string,
  prompt: string,
  body: string,
  options: { validationStartedAt?: string; validationFinishedAt?: string } = {}
): Promise<void> {
  const runId = prompt.match(/^Run ID: (.+)$/m)?.[1] ?? "missing-run-id";
  const validationPath = `.agent-os/validation/${issueIdentifier}.json`;
  await mkdir(join(workspacePath, ".agent-os", "validation"), { recursive: true });
  await writeFile(join(workspacePath, ".agent-os", `handoff-${issueIdentifier}.md`), `${body}\n\nValidation-JSON: ${validationPath}`, "utf8");
  const now = new Date().toISOString();
  const validationStartedAt = options.validationStartedAt ?? now;
  const validationFinishedAt = options.validationFinishedAt ?? now;
  await writeValidationEvidence(join(workspacePath, validationPath), {
    schemaVersion: 1,
    issueIdentifier,
    runId,
    status: "passed",
    finalResult: {
      status: "passed",
      command: "npm run agent-check",
      exitCode: 0,
      startedAt: validationStartedAt,
      finishedAt: validationFinishedAt
    },
    commands: [
      {
        name: "npm run agent-check",
        exitCode: 0,
        startedAt: validationStartedAt,
        finishedAt: validationFinishedAt
      }
    ]
  });
}

function reviewArtifactScope(input: Parameters<AgentRunner["run"]>[0]): { runId?: string; headSha?: string; iteration?: number } {
  const runId = input.prompt.match(/^- Run:\s*(.+)$/m)?.[1]?.trim();
  const headSha = input.prompt.match(/^- Head SHA:\s*(.+)$/m)?.[1]?.trim();
  const iterationText = input.prompt.match(/^- Iteration:\s*(\d+)$/m)?.[1];
  const iteration = iterationText ? Number(iterationText) : undefined;
  return {
    ...(runId ? { runId } : {}),
    ...(headSha ? { headSha } : {}),
    ...(Number.isInteger(iteration) ? { iteration } : {})
  };
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} failed`));
    });
  });
}

async function initGitRemote(repo: string, remote = "https://github.com/o/r.git"): Promise<void> {
  await run("git", ["init"], repo);
  await run("git", ["remote", "add", "origin", remote], repo).catch(async () => {
    await run("git", ["remote", "set-url", "origin", remote], repo);
  });
}

async function initCleanWorkspaceAtOriginMain(workspacePath: string): Promise<void> {
  const remote = `${workspacePath}-remote.git`;
  await run("git", ["init", "--bare", remote], workspacePath);
  await run("git", ["init", "-b", "main"], workspacePath);
  await run("git", ["config", "user.email", "agentos@example.test"], workspacePath);
  await run("git", ["config", "user.name", "AgentOS Test"], workspacePath);
  await writeFile(join(workspacePath, "README.md"), "initial\n", "utf8");
  await run("git", ["add", "README.md"], workspacePath);
  await run("git", ["commit", "-m", "initial"], workspacePath);
  await run("git", ["remote", "add", "origin", remote], workspacePath);
  await run("git", ["push", "-u", "origin", "main"], workspacePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timeout");
    await sleep(5);
  }
}
