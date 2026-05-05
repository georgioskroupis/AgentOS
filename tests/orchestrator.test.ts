import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentRunResult, AgentRunner, Issue, IssueTracker } from "../src/types.js";
import { JsonlLogger } from "../src/logging.js";
import { RunArtifactStore } from "../src/runs.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
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
  });

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
  });

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
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.activeRuns).toEqual([]);
    expect(runtime.retryQueue).toEqual([]);
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
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        phase: "streaming-turn",
        prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: new Date().toISOString() }],
        nextRetryAt: "2026-01-01T00:00:00.000Z",
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
          headRefName: "agent/AG-1",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: readyIssue.id,
      identifier: readyIssue.identifier,
      issue: readyIssue,
      attempt: 1,
      dueAt: "2026-01-01T00:00:00.000Z",
      error: "stale retry",
      scheduledAt: "2026-01-01T00:00:00.000Z"
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
      lifecycleStatus: "already_merged_pr"
    });
    expect(state.nextRetryAt).toBeUndefined();
    const runtime = await new RuntimeStateStore(repo).read();
    expect(runtime.retryQueue).toEqual([]);
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

    expect((await new RunArtifactStore(repo).inspect(run.runId)).summary.status).toBe("stale");
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
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\nagent:\n  max_turns: 1\n  max_retry_attempts: 1\nworkspace:\n  root: .agent-os/workspaces\ncodex:\n  stall_timeout_ms: 25\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
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
    await waitUntil(() => eventCount > 0);
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
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
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
          state: "MERGED",
          isDraft: false,
          mergeable: null,
          mergedAt: "2026-05-05T08:00:00Z",
          headRefName: "agent/AG-1",
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
    expect(comments.join("\n")).toContain("No merge-eligible pull request output was selected");
    expect(comments.join("\n")).toContain("approval of the handoff without a merge");
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
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "AG-1",
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
    expect(fixPromptText).toContain("TS2304");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewIteration).toBe(2);
  });

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
  });

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
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("human_required");
    expect(state.findings[0].body).toContain("invalid review JSON");
    const canonicalArtifact = JSON.parse(await readFile(join(repo, ".agent-os", "reviews", "AG-1", "iteration-1", "self.json"), "utf8"));
    expect(canonicalArtifact.decision).toBe("human_required");
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
