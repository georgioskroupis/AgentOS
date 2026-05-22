import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const architectureScript = resolve("scripts/check-architecture.mjs");
const docsScript = resolve("scripts/check-docs.mjs");

describe("architecture and docs checks", () => {
  it("accepts a minimal architecture fixture", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-pass-"));
    await writeArchitectureFixture(repo);

    await expect(execNode(architectureScript, repo)).resolves.toMatchObject({ stdout: expect.stringContaining("Architecture check passed.") });
  });

  it("reports duplicate workflow concepts with remediation guidance", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-duplicate-"));
    await writeArchitectureFixture(repo);
    await writeFile(join(repo, "src", "cli.ts"), 'const program = { command() { return this; } };\nprogram.command("status");\nprogram.command("status");\n', "utf8");

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("duplicate workflow concept"),
      code: 1
    });
  });

  it("reports hidden lifecycle policy and file-size violations", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-hidden-"));
    await writeArchitectureFixture(repo);
    await writeFile(join(repo, "src", "random-policy.ts"), 'export const state = "Human Review";\n', "utf8");
    await writeFile(join(repo, "src", "oversized.ts"), `${Array.from({ length: 652 }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`, "utf8");

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("hidden lifecycle policy"),
      code: 1
    });
    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("above the 650-line budget"),
      code: 1
    });
  });

  it("accepts a minimal docs fixture", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-docs-pass-"));
    await writeDocsFixture(repo);

    await expect(execNode(docsScript, repo)).resolves.toMatchObject({ stdout: expect.stringContaining("Docs check passed.") });
  });

  it("reports broken links and stale CLI command references", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-docs-fail-"));
    await writeDocsFixture(repo);
    await writeFile(join(repo, "docs", "product", "README.md"), "Broken [link](../missing.md).\nRun `agent-os frobnicate`.\n", "utf8");

    await expect(execNode(docsScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("broken link"),
      code: 1
    });
    await expect(execNode(docsScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown CLI command agent-os frobnicate"),
      code: 1
    });
  });

  it("reports unclassified test files in the test-suite inventory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-docs-test-suite-fail-"));
    await writeDocsFixture(repo);
    await mkdir(join(repo, "tests"), { recursive: true });
    await writeFile(join(repo, "tests", "new-behavior.test.ts"), "import { it } from 'vitest';\nit('protects behavior', () => {});\n", "utf8");

    await expect(execNode(docsScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("does not classify tests/new-behavior.test.ts"),
      code: 1
    });
  });

  it("keeps agent-check scripts noisy enough for long validation phases", async () => {
    const rootScript = await readFile("scripts/agent-check.sh", "utf8");
    const templateScript = await readFile("templates/base-harness/scripts/agent-check.sh", "utf8");
    for (const script of [rootScript, templateScript]) {
      expect(script).toContain("AGENT_CHECK_HEARTBEAT_SECONDS");
      expect(script).toContain("still running after");
      expect(script).toContain("passed in");
      expect(script).toContain("failed in");
    }
  });
});

async function writeArchitectureFixture(repo: string): Promise<void> {
  for (const dir of ["src/runner", "templates/base-harness/.agents/skills/implement-feature", "skills/implement-feature"]) {
    await mkdir(join(repo, dir), { recursive: true });
  }
  const workflow = [
    "---",
    "tracker:",
    "  active_states:",
    "    - Todo",
    "    - In Progress",
    "  terminal_states:",
    "    - Done",
    "    - Closed",
    "    - Canceled",
    "    - Duplicate",
    "  review_state: Human Review",
    "  merge_state: Merging",
    "---",
    "## Issue Outcomes",
    "",
    "Issues are the unit of work. PRs are optional outputs.",
    "",
    "## Agent Prompt",
    "",
    "Do work."
  ].join("\n");
  await writeFile(join(repo, "WORKFLOW.md"), workflow, "utf8");
  await writeFile(join(repo, "templates/base-harness", "WORKFLOW.md"), workflow, "utf8");
  await writeFile(join(repo, "README.md"), "Issues are the unit of work. PRs are optional outputs.\n", "utf8");
  await writeFile(join(repo, "skills/implement-feature/SKILL.md"), "Issues are the unit of work. PRs are optional outputs.\n", "utf8");
  await writeFile(join(repo, "templates/base-harness/.agents/skills/implement-feature/SKILL.md"), "Issues are the unit of work. PRs are optional outputs.\n", "utf8");
  await writeFile(join(repo, "src", "types.ts"), "export interface Thing { value: string }\n", "utf8");
  await writeFile(join(repo, "src/runner", "app-server.ts"), "export const runner = true;\n", "utf8");
  await writeFile(join(repo, "src", "fs-utils.ts"), "export const fsUtils = true;\n", "utf8");
  await writeFile(join(repo, "src", "github.ts"), "export const github = true;\n", "utf8");
  await writeFile(join(repo, "src", "linear.ts"), "export const linear = true;\n", "utf8");
  await writeFile(join(repo, "src", "status.ts"), "export const status = true;\n", "utf8");
  await writeFile(join(repo, "src", "cli.ts"), 'const program = { command() { return this; } };\nprogram.command("init");\nprogram.command("status");\n', "utf8");
}

async function writeDocsFixture(repo: string): Promise<void> {
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "cli.ts"), 'program.command("init");\nprogram.command("status");\n', "utf8");
  const requiredDocs = [
    "docs/architecture/README.md",
    "docs/architecture/AGENT_OS.md",
    "docs/decisions/README.md",
    "docs/product/README.md",
    "docs/quality/APP_LEGIBILITY.md",
    "docs/quality/PROOF_OF_WORK.md",
    "docs/quality/QUALITY_SCORE.md",
    "docs/quality/TEST_SUITE.md",
    "docs/runbooks/README.md",
    "docs/runbooks/LINEAR_SETUP.md",
    "docs/runbooks/MAINTENANCE.md",
    "docs/runbooks/ROLLOUT.md",
    "docs/runbooks/MIGRATIONS.md",
    "docs/runbooks/DOGFOODING.md",
    "docs/planning/SOURCE_ALIGNMENT_AUDIT.md",
    "docs/security/SECURITY.md",
    "docs/security/ORCHESTRATOR_TRUST_MODEL.md"
  ];
  await writeFile(join(repo, "README.md"), "Use `agent-os init` and `agent-os status`.\n", "utf8");
  await writeFile(join(repo, "AGENTS.md"), "Agents.\n", "utf8");
  await writeFile(join(repo, "ARCHITECTURE.md"), "Architecture.\n", "utf8");
  await writeFile(join(repo, "WORKFLOW.md"), "Workflow.\n", "utf8");
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "docs", "README.md"), requiredDocs.map((path) => `- \`${path}\``).join("\n"), "utf8");
  for (const path of requiredDocs) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    let text = `${path}\n`;
    if (path.endsWith("SOURCE_ALIGNMENT_AUDIT.md")) {
      text = "pre-dispatch reconciliation\nrecoverable partial work\ndaemon liveness\nExisting Implementation Audit\ncheck:architecture\ncheck:docs\n";
    } else if (path.endsWith("QUALITY_SCORE.md")) {
      text = qualityScoreFixture();
    } else if (path.endsWith("TEST_SUITE.md")) {
      text = testSuiteFixture();
    } else if (path.endsWith("MAINTENANCE.md")) {
      text = "Generic maintenance prompt: do not use a hard-coded roadmap range.\n";
    }
    await writeFile(join(repo, path), text, "utf8");
  }
  await writeMaintenanceTemplateFixture(repo);
}

async function writeMaintenanceTemplateFixture(repo: string): Promise<void> {
  const templates = [
    "doc-gardening",
    "stale-runbook-detection",
    "quality-score-refresh",
    "architecture-drift-scan",
    "obsolete-skill-cleanup",
    "stale-pr-branch-report",
    "merged-pr-cleanup-drift-report",
    "stale-daemon-repo-sha-report",
    "stale-workspace-lock-retry-report",
    "automation-prompt-drift-report",
    "unpublished-issue-branch-failed-pr-creation-report"
  ];
  await mkdir(join(repo, "templates", "maintenance"), { recursive: true });
  for (const slug of templates) {
    const extra =
      slug === "doc-gardening"
        ? [
            "more than one active issue",
            "In Progress",
            "Human Review",
            "Merging",
            "PRs merged while",
            "checks are failing",
            "root `main` is behind `origin/main`",
            "daemon",
            "stale workspace locks",
            "dirty source state",
            "committed work not pushed to origin",
            "validation, handoff, or PR body artifacts",
            "agent_pr_creation_failed",
            "hard-coded roadmap"
          ].join("\n")
        : "recurring maintenance template\n";
    await writeFile(join(repo, "templates", "maintenance", `${slug}.md`), `# ${slug}\n${extra}\n`, "utf8");
  }
}

function testSuiteFixture(): string {
  return [
    "# Test Suite Map",
    "",
    "## Layer Rules",
    "",
    "Prefer narrow tests.",
    "",
    "## Audit Findings",
    "",
    "No unclassified tests.",
    "",
    "## Inventory",
    "",
    "| File | Layer | Contract Protected |",
    "| --- | --- | --- |",
    "",
    "## When To Prune",
    "",
    "Prune obsolete coverage only."
  ].join("\n");
}

function qualityScoreFixture(): string {
  return [
    "# Quality Score",
    "",
    "| Area | Target |",
    "| --- | --- |",
    "| Context | Current source of truth |",
    "| Validation | Local validation |",
    "| Observability | Status and logs |",
    "| Lifecycle | Workflow states |",
    "| Review loops | Review and fixer loop |",
    "| Restart recovery | Recovery behavior |",
    "| Application legibility | App proof |",
    "| Source alignment | Source-aligned docs |",
    "| Merge cleanup health | Cleanup drift |",
    "| Daemon/runtime freshness | Runtime freshness |",
    "| Monitor automation health | Maintenance health |",
    "| PR publication/handoff completion health | PR and handoff completion |",
    ""
  ].join("\n");
}

function execNode(script: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(process.execPath, [script], { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr, code: error.code }));
        return;
      }
      resolvePromise({ stdout, stderr, code: 0 });
    });
  });
}
