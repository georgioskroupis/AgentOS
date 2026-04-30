import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});

