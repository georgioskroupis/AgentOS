import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, parseWorkflowText, renderPrompt, resolveServiceConfig } from "../src/workflow.js";
import type { Issue } from "../src/types.js";

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Build the thing",
  description: null,
  priority: 1,
  state: "Ready",
  branch_name: null,
  url: "https://linear.test/AG-1",
  labels: [],
  blocked_by: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z"
};

describe("workflow", () => {
  it("parses front matter and resolves env-backed config", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\nworkspace:\n  root: .agent-os/workspaces\n---\nHello {{ issue.identifier }}`,
      "utf8"
    );
    const workflow = await loadWorkflow(workflowPath);
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    expect(config.tracker.apiKey).toBe("lin_test");
    expect(config.tracker.projectSlug).toBe("AgentOS");
    expect(config.tracker.runningState).toBe("In Progress");
    expect(config.tracker.reviewState).toBe("Human Review");
    expect(config.tracker.mergeState).toBeNull();
    expect(config.agent.maxRetryAttempts).toBe(3);
    expect(config.github).toMatchObject({
      command: "gh",
      mergeMethod: "squash",
      requireChecks: true,
      deleteBranch: true,
      doneState: "Done",
      allowHumanMergeOverride: true
    });
    expect(config.review).toMatchObject({
      enabled: true,
      maxIterations: 3,
      requiredReviewers: ["self", "correctness", "tests", "architecture"],
      optionalReviewers: ["security"],
      requireAllBlockingResolved: true,
      blockingSeverities: ["P0", "P1", "P2"]
    });
    expect(config.workspace.root).toContain(".agent-os/workspaces");
  });

  it("renders prompts strictly", async () => {
    await expect(renderPrompt("Hello {{ issue.identifier }}", issue, null)).resolves.toBe("Hello AG-1");
    await expect(renderPrompt("Hello {{ issue.missing }}", issue, null)).rejects.toThrow();
  });

  it("allows workflows without front matter", () => {
    const parsed = parseWorkflowText("Body");
    expect(parsed.config).toEqual({});
    expect(parsed.body).toBe("Body");
  });
});
