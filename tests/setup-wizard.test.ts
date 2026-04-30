import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSetupWizard } from "../src/setup-wizard.js";

describe("setup wizard", () => {
  it("performs a dry run without writing files", async () => {
    const repo = join(await mkdtemp(join(tmpdir(), "agent-os-setup-dry-parent-")), "new-project");
    const report = await runSetupWizard({
      projectPath: repo,
      dryRun: true,
      mode: "greenfield",
      project: "Dry Run Project",
      useCodexSummary: false,
      interactive: false
    });

    expect(report.mode).toBe("greenfield");
    await expect(stat(repo)).rejects.toThrow();
  });

  it("uses AGENTOS_WORKFLOW.md when an existing workflow is not AgentOS-owned", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-setup-existing-"));
    await writeFile(join(repo, "WORKFLOW.md"), "# Existing team workflow\n", "utf8");
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "existing", scripts: { test: "node --test" } }), "utf8");

    const report = await runSetupWizard({
      projectPath: repo,
      dryRun: false,
      mode: "existing",
      project: "Existing Project",
      team: "VER",
      useCodexSummary: false,
      commit: false,
      interactive: false,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" },
      summaryProvider: async () => null,
      verify: false,
      linearClient: {
        async listTeams() {
          return [{ id: "team-1", key: "VER", name: "Verity" }];
        },
        async findProject() {
          return { id: "project-1", name: "Existing Project", slugId: "Existing Project" };
        },
        async createProject() {
          throw new Error("not needed");
        },
        async ensureWorkflowStates() {
          return { states: [], created: [], missing: [] };
        }
      }
    });

    expect(report.workflowPath.endsWith("AGENTOS_WORKFLOW.md")).toBe(true);
    const workflow = await readFile(join(repo, "AGENTOS_WORKFLOW.md"), "utf8");
    expect(workflow).toContain("project_slug: Existing Project");
  });

  it("preserves existing AgentOS-owned workflow body", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-setup-preserve-workflow-"));
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "tracker:",
        "  project_slug: Old",
        "---",
        "",
        "# AgentOS Workflow",
        "",
        "## Custom Section",
        "",
        "Keep this carefully written workflow text.",
        "",
        "Ralph Wiggum",
        "AgentOS-Outcome: implemented",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "preserve", scripts: { test: "node --test" } }), "utf8");

    await runSetupWizard({
      projectPath: repo,
      dryRun: false,
      mode: "existing",
      project: "Preserve Project",
      team: "VER",
      useCodexSummary: false,
      commit: false,
      interactive: false,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" },
      verify: false,
      linearClient: {
        async listTeams() {
          return [{ id: "team-1", key: "VER", name: "Verity" }];
        },
        async findProject() {
          return { id: "project-1", name: "Preserve Project", slugId: "preserve-slug" };
        },
        async createProject() {
          throw new Error("not needed");
        },
        async ensureWorkflowStates() {
          return { states: [], created: [], missing: [] };
        }
      }
    });

    const workflow = await readFile(join(repo, "WORKFLOW.md"), "utf8");
    expect(workflow).toContain("## Custom Section");
    expect(workflow).toContain("Keep this carefully written workflow text.");
    expect(workflow).toContain("<!-- AGENTOS:WORKFLOW-CONTEXT:BEGIN -->");
    expect(workflow).toContain("project_slug: Preserve Project");
    expect(workflow).toContain('after_create: bash "$AGENT_OS_SOURCE_REPO/scripts/agent-bootstrap-worktree.sh"');
  });

  it("can install a local harness without touching Linear", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-setup-offline-"));

    const report = await runSetupWizard({
      projectPath: repo,
      dryRun: false,
      mode: "greenfield",
      project: "Offline Project",
      linear: false,
      useCodexSummary: false,
      commit: false,
      interactive: false,
      verify: false
    });

    expect(report.linearProject).toBeUndefined();
    expect(report.createdStates).toHaveLength(0);
    await expect(readFile(join(repo, "WORKFLOW.md"), "utf8")).resolves.toContain("Offline Project");
  });
});
