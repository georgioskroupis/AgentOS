import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow, parseWorkflowText, renderPrompt, resolveServiceConfig, validateWorkflowDefinition } from "../src/workflow.js";
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
    expect(config.trustMode).toBe("ci-locked");
    expect(config.codex.command).toBe("npx -y @openai/codex@0.125.0 app-server");
    expect(config.codex.approvalEventPolicy).toBe("deny");
    expect(config.codex.userInputPolicy).toBe("deny");
    expect(config.codex.turnSandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: false });
    expect(config.agent.maxRetryAttempts).toBe(3);
    expect(config.github).toMatchObject({
      command: "gh",
      mergeMode: "manual",
      mergeMethod: "squash",
      requireChecks: true,
      deleteBranch: true,
      doneState: "Done",
      allowHumanMergeOverride: false
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

  it("validates strict workflow safety defaults", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-strict-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "codex:",
        "  command: npx -y @openai/codex@0.125.0 app-server",
        "github:",
        "  merge_mode: manual",
        "  allow_human_merge_override: false",
        "---",
        "Hello {{ issue.identifier }}"
      ].join("\n"),
      "utf8"
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(validateWorkflowDefinition(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true)).toMatchObject({
      ok: true,
      errors: []
    });

    const loose = await loadWorkflow(join(repo, "WORKFLOW.md"));
    loose.config = { tracker: { api_key: "$LINEAR_API_KEY", project_slug: "AgentOS" } };
    expect(validateWorkflowDefinition(loose, { LINEAR_API_KEY: "", HOME: "/tmp" }, true).errors).toContain("tracker.api_key did not resolve from the environment");
  });

  it("validates trust-mode PR and network compatibility", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-trust-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "trust_mode: ci-locked",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "codex:",
        "  turn_sandbox_policy:",
        "    type: workspaceWrite",
        "    networkAccess: true",
        "  approval_event_policy: allow",
        "  user_input_policy: allow",
        "github:",
        "  merge_mode: shepherd",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );

    const workflow = await loadWorkflow(workflowPath);
    const result = validateWorkflowDefinition(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true);
    expect(result.errors).toContain("codex.turn_sandbox_policy.networkAccess=true is incompatible with trust_mode=ci-locked");
    expect(result.errors).toContain("github.merge_mode=shepherd requires a trust mode with GitHub merge capability");
    expect(result.errors).toContain("github.merge_mode=shepherd requires PR/network capability");
    expect(result.errors).toContain("codex.approval_event_policy=allow requires trust_mode=danger");
    expect(result.errors).toContain("codex.user_input_policy=allow requires a trust mode with Codex user input capability");
  });

  it("guides agents to non-interactive PR creation instead of MCP elicitation", async () => {
    for (const path of ["WORKFLOW.md", "templates/base-harness/WORKFLOW.md"]) {
      const text = await readFile(path, "utf8");
      expect(text).toContain("scripts/agent-create-pr.sh");
      expect(text).toContain("--title");
      expect(text).toContain("--body-file");
      expect(text).toContain("--base");
      expect(text).toContain("--head");
      expect(text).toContain("Do not use GitHub app/MCP PR creation tools");
      expect(text).toContain("agent_pr_creation_failed");
      expect(text).toContain("prs[]");
    }
  });
});
