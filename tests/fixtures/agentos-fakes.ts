import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunResult, AgentRunner, Issue, IssueTracker, ServiceConfig, Workspace } from "../../src/types.js";

export function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "AG-1",
    title: "Characterized issue",
    description: null,
    priority: 1,
    state: "Ready",
    branch_name: null,
    url: "https://linear.test/AG-1",
    labels: [],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

export function fakeServiceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    trustMode: "ci-locked",
    tracker: {
      kind: "linear",
      endpoint: "https://linear.test/graphql",
      apiKey: "lin_test",
      projectSlug: "AgentOS",
      activeStates: ["Ready"],
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
    },
    ...overrides
  };
}

export class FakeTracker implements IssueTracker {
  comments: Array<{ issue: string; body: string }> = [];
  moves: Array<{ issue: string; state: string }> = [];

  constructor(
    private candidates: Issue[],
    private states = new Map<string, Issue | null>()
  ) {}

  async fetchCandidates(): Promise<Issue[]> {
    return this.candidates;
  }

  async fetchIssueStates(issueIds: string[]): Promise<Map<string, Issue | null>> {
    return new Map(issueIds.map((id) => [id, this.states.get(id) ?? null]));
  }

  async comment(issue: string, body: string): Promise<void> {
    this.comments.push({ issue, body });
  }

  async move(issue: string, state: string): Promise<void> {
    this.moves.push({ issue, state });
  }
}

export class FakeRunner implements AgentRunner {
  prompts: string[] = [];
  workspaces: Workspace[] = [];

  constructor(private readonly result: AgentRunResult | ((workspace: Workspace) => Promise<AgentRunResult>)) {}

  async run(input: Parameters<AgentRunner["run"]>[0]): Promise<AgentRunResult> {
    this.prompts.push(input.prompt);
    this.workspaces.push(input.workspace);
    return typeof this.result === "function" ? this.result(input.workspace) : this.result;
  }
}

export async function writeHandoff(workspace: Workspace, issueIdentifier: string, body: string): Promise<void> {
  await mkdir(join(workspace.path, ".agent-os"), { recursive: true });
  await writeFile(join(workspace.path, ".agent-os", `handoff-${issueIdentifier}.md`), body, "utf8");
}
