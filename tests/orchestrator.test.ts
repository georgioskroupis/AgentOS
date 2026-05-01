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
        await mkdir(join(input.workspace.path, ".agent-os"), { recursive: true });
        await writeFile(
          join(input.workspace.path, ".agent-os", "handoff-AG-1.md"),
          "### Handoff\n\nValidation passed.\n\nPR: https://github.com/o/r/pull/1",
          "utf8"
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
    expect(comments[0]).toContain("AgentOS started");
    expect(comments[1]).toContain("Validation passed.");
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.prUrl).toBe("https://github.com/o/r/pull/1");
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
        return prompts.length === 1 ? { status: "failed", error: "boom" } : { status: "succeeded" };
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
          await mkdir(join(input.workspace.path, ".agent-os"), { recursive: true });
          await writeFile(join(input.workspace.path, ".agent-os", "handoff-AG-1.md"), "AgentOS-Outcome: already-satisfied", "utf8");
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
        await mkdir(join(input.workspace.path, ".agent-os"), { recursive: true });
        await writeFile(
          join(input.workspace.path, ".agent-os", "handoff-AG-1.md"),
          [
            "AgentOS-Outcome: already-satisfied",
            "",
            "### Implementation audit",
            "",
            "Acceptance criteria are already covered by the current codebase.",
            "",
            "Validation: npm run agent-check passed."
          ].join("\n"),
          "utf8"
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
        const reviewer = input.prompt.match(/You are the (.+) automated reviewer/)?.[1] ?? "self";
        await writeReviewArtifact(artifactPath, {
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
    const state = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(state.reviewStatus).toBe("approved");
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
