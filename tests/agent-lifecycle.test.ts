import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachPrWithAgentLifecycleTool,
  commentWithAgentLifecycleTool,
  moveWithAgentLifecycleTool,
  recordHandoffWithAgentLifecycleTool
} from "../src/agent-lifecycle.js";
import type { AgentLifecycleTracker } from "../src/agent-lifecycle.js";
import type { LinearCommentWriteResult, LinearIssueReference } from "../src/linear.js";
import type { ServiceConfig } from "../src/types.js";

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

  it("strictly gates experimental agent-owned lifecycle writes before lookup or fallback", async () => {
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
    await writeFile(
      handoffPath,
      [
        "AgentOS-Outcome: implemented",
        "",
        `Summary with token ${token}`,
        "",
        "PR: https://github.com/o/r/pull/13"
      ].join("\n"),
      "utf8"
    );
    const tracker = new MemoryTracker();

    await recordHandoffWithAgentLifecycleTool(
      { repoRoot: repo, config: lifecycleConfig(), tracker },
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

  constructor(private readonly issue: Partial<LinearIssueReference> = {}) {}

  async findIssueReference(issueIdentifierOrId: string): Promise<LinearIssueReference> {
    this.lookups.push(issueIdentifierOrId);
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
      idempotencyMarkerFormat: "<!-- agentos:event={event} issue={issue} -->",
      allowedStateTransitions: ["Todo -> In Progress", "In Progress -> Human Review"],
      duplicateCommentBehavior: "upsert",
      fallbackBehavior: "write handoff and stop human_required",
      maturityAcknowledgement: null,
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
      allowHumanMergeOverride: false
    },
    review: {
      enabled: false,
      maxIterations: 1,
      requiredReviewers: ["self", "correctness", "tests", "architecture"],
      optionalReviewers: ["security"],
      requireAllBlockingResolved: true,
      blockingSeverities: ["P0", "P1", "P2"]
    }
  };
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
