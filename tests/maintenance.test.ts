import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMaintenanceTemplates, seedMaintenanceIssues, type MaintenanceSeedClient } from "../src/maintenance.js";

const expectedTemplateSlugs = [
  "architecture-drift-scan",
  "automation-prompt-drift-report",
  "doc-gardening",
  "merged-pr-cleanup-drift-report",
  "obsolete-skill-cleanup",
  "quality-score-refresh",
  "stale-daemon-repo-sha-report",
  "stale-pr-branch-report",
  "stale-runbook-detection",
  "stale-workspace-lock-retry-report",
  "unpublished-issue-branch-failed-pr-creation-report"
];

describe("maintenance templates", () => {
  it("loads the recurring maintenance issue templates", async () => {
    const templates = await loadMaintenanceTemplates();
    const combined = templates.map((template) => template.description).join("\n").toLowerCase();

    expect(templates.map((template) => template.slug)).toEqual(expectedTemplateSlugs);
    expect(templates.map((template) => template.title)).toContain("Doc-gardening pass");
    expect(templates.map((template) => template.title)).toContain("Unpublished issue branch and failed PR creation report");
    expect(combined).toContain("more than one active issue");
    expect(combined).toContain("root `main` is behind `origin/main`");
    expect(combined).toContain("agent_pr_creation_failed");
    expect(combined).toContain("hard-coded roadmap");
  });

  it("seeds every template into the requested Linear project and state", async () => {
    const created: Array<{ teamId: string; title: string; description: string; projectId?: string; stateId?: string }> = [];
    const client: MaintenanceSeedClient = {
      async listTeams() {
        return [{ id: "team-1", key: "VER", name: "Verity" }];
      },
      async listWorkflowStates() {
        return [{ id: "state-backlog", name: "Backlog" }];
      },
      async findProject() {
        return null;
      },
      async createProject(name, teamId) {
        return { id: "project-1", name, slugId: `${teamId}-agentos` };
      },
      async createIssue(input) {
        created.push(input);
        return { id: `issue-${created.length}`, identifier: `VER-${created.length}`, title: input.title };
      }
    };

    const result = await seedMaintenanceIssues(client, { team: "VER", project: "AgentOS" });

    expect(result.issues).toHaveLength(expectedTemplateSlugs.length);
    expect(created).toHaveLength(expectedTemplateSlugs.length);
    expect(created.every((issue) => issue.teamId === "team-1")).toBe(true);
    expect(created.every((issue) => issue.projectId === "project-1")).toBe(true);
    expect(created.every((issue) => issue.stateId === "state-backlog")).toBe(true);
    expect(created.some((issue) => issue.title === "Quality-score refresh")).toBe(true);
  });

  it("exposes the top-level maintenance seed command", async () => {
    const result = await execNode([process.execPath, "--import", "tsx", resolve("src/cli.ts"), "maintenance", "--help"]);

    expect(result.stdout).toContain("seed");
    expect(result.stdout).toContain("Seed recurring AgentOS maintenance work");
  });
});

function execNode(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const [command, ...commandArgs] = args;
  return new Promise((resolvePromise, reject) => {
    execFile(command, commandArgs, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}
