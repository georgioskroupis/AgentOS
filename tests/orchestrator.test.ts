import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentRunResult, AgentRunner, Issue, IssueTracker } from "../src/types.js";
import { JsonlLogger } from "../src/logging.js";

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
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nworkspace:\n  root: .agent-os/workspaces\n---\nDo {{ issue.identifier }}`,
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
    expect(prompt).toBe("Do AG-1");
    const logs = await logger.tail(10);
    expect(logs.some((entry) => entry.type === "run_succeeded")).toBe(true);
  });

  it("owns Linear lifecycle updates and posts the agent handoff", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-linear-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  running_state: In Progress\n  review_state: Human Review\n  needs_input_state: Human Review\nworkspace:\n  root: .agent-os/workspaces\n---\nDo {{ issue.identifier }}`,
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
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\nagent:\n  max_retry_backoff_ms: 1\nworkspace:\n  root: .agent-os/workspaces\n---\nAttempt {{ attempt | default: 0 }} for {{ issue.identifier }}`,
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

    expect(prompts).toEqual(["Attempt 0 for AG-1", "Attempt 1 for AG-1"]);
  });

  it("shepherds a mergeable PR from Merging to Done without running Codex", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-orch-merge-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    const ghState = join(repo, "gh-state.json");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  done_state: Done\n---\nDo {{ issue.identifier }}`,
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
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n  active_states: [Ready]\n  review_state: Human Review\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}\n  done_state: Done\n---\nDo {{ issue.identifier }}`,
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
});
