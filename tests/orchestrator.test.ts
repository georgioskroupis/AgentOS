import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentRunResult, AgentRunner, Issue, IssueTracker } from "../src/types.js";
import { JsonlLogger } from "../src/logging.js";
import { RunArtifactStore } from "../src/runs.js";
import { writeReviewArtifact } from "../src/review.js";
import { writeValidationEvidence } from "../src/validation.js";

const readyIssue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Ready issue",
  description: null,
  priority: 1,
  state: "Ready",
  branch_name: null,
  url: null,
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
    const runner: AgentRunner = {
      async run(input): Promise<AgentRunResult> {
        prompt = input.prompt;
        await writePassingHandoff(input.workspace.path, "AG-1", input.prompt, "AgentOS-Outcome: already-satisfied");
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
    const logs = await logger.tail(10);
    expect(logs.some((entry) => entry.type === "run_succeeded")).toBe(true);
  });

  it("owns Linear lifecycle updates and posts the agent handoff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-linear-"));
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
    const events = await new RunArtifactStore(repo).replay(summary.runId);
    expect(events.some((event) => event.type === "run_needs_human_input" && event.message === "codex_elicitation_request_denied")).toBe(true);
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
        return new Map([[readyIssue.id, { ...readyIssue, state: "Human Review" }]]);
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
    const events = await new RunArtifactStore(repo).replay(summary.runId);
    expect(events.some((event) => event.type === "validation_failed")).toBe(true);
    expect(events.some((event) => event.type === "run_succeeded")).toBe(false);
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
  });

  it("persists multiple PR outputs without collapsing issue state to one PR", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-multi-pr-"));
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
  });

  it("shepherds a mergeable PR from Merging to Done without running Codex", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-"));
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
        prUrl: "https://github.com/o/r/pull/1",
        prs: [{ url: "https://github.com/o/r/pull/2", source: "handoff", discoveredAt: new Date().toISOString() }],
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
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
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
    expect(comments.join("\n")).toContain("No pull request outputs were recorded");
    expect(comments.join("\n")).toContain("approval of the no-PR handoff");
  });

  it("routes unsafe merge shepherd failures back to Human Review", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-fail-"));
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

  it("runs automated reviewers before moving an implemented PR to Human Review", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-"));
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
        reviewArtifactPrompts.push(artifactPath);
        reviewSandboxPolicies.push(input.config.codex.turnSandboxPolicy);
        const reviewer = input.prompt.match(/You are the (.+) automated reviewer/)?.[1] ?? "self";
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer,
          decision: "approved",
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
  });

  it("escalates malformed review artifacts to human_required", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-review-malformed-"));
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
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.findings[0].body).toContain("invalid review JSON");
    const canonicalArtifact = JSON.parse(await readFile(join(repo, ".agent-os", "reviews", "AG-1", "iteration-1", "self.json"), "utf8"));
    expect(canonicalArtifact.decision).toBe("human_required");
  });

  it("blocks unapproved merge state when human override is disabled", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-review-gate-"));
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
});

async function writePassingHandoff(workspacePath: string, issueIdentifier: string, prompt: string, body: string): Promise<void> {
  const runId = prompt.match(/^Run ID: (.+)$/m)?.[1] ?? "missing-run-id";
  const validationPath = `.agent-os/validation/${issueIdentifier}.json`;
  await mkdir(join(workspacePath, ".agent-os", "validation"), { recursive: true });
  await writeFile(join(workspacePath, ".agent-os", `handoff-${issueIdentifier}.md`), `${body}\n\nValidation-JSON: ${validationPath}`, "utf8");
  const now = new Date().toISOString();
  await writeValidationEvidence(join(workspacePath, validationPath), {
    schemaVersion: 1,
    issueIdentifier,
    runId,
    status: "passed",
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
