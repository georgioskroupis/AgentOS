import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const architectureScript = resolve("scripts/check-architecture.mjs");
const docsScript = resolve("scripts/check-docs.mjs");
const traceabilityScript = resolve("scripts/check-traceability.mjs");
const agentOwnedCertificationScript = resolve("scripts/certification-agent-owned.mjs");

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

  it("reports a missing lifecycle boundary contract file", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-lifecycle-file-missing-"));
    await writeArchitectureFixture(repo);
    await rm(join(repo, "src", "lifecycle-events.ts"));

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringMatching(/src\/lifecycle-events\.ts lifecycle boundary contract file is missing[\s\S]*Add src\/lifecycle-events\.ts before lifecycle extraction/),
      code: 1
    });
  });

  it("reports a missing tracker boundary contract file", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-tracker-file-missing-"));
    await writeArchitectureFixture(repo);
    await rm(join(repo, "src", "tracker-boundaries.ts"));

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringMatching(/src\/tracker-boundaries\.ts tracker boundary contract file is missing[\s\S]*Add src\/tracker-boundaries\.ts before lifecycle extraction/),
      code: 1
    });
  });

  it("reports a missing lifecycle controller implementation", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-controller-missing-"));
    await writeArchitectureFixture(repo);
    await rm(join(repo, "src", "lifecycle-controller.ts"));

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringMatching(/src\/lifecycle-controller\.ts lifecycle controller implementation is missing[\s\S]*Add a thin lifecycle controller/),
      code: 1
    });
  });

  it("reports missing lifecycle boundary contracts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-boundary-missing-"));
    await writeArchitectureFixture(repo);
    await writeFile(join(repo, "src", "lifecycle-events.ts"), "export interface LifecycleEvent { schemaVersion: 1 }\n", "utf8");

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("missing lifecycle boundary contract export"),
      code: 1
    });
  });

  it("reports direct tracker writes and raw tracker mutations in core scheduler code", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-tracker-write-"));
    await writeArchitectureFixture(repo);
    await writeFile(
      join(repo, "src", "orchestrator.ts"),
      [
        'import { LinearClient } from "./linear.js";',
        "export class Orchestrator {",
        "  private tracker = {} as { move?: (issue: string, state: string) => Promise<void> };",
        "  async run() {",
        "    await this.tracker.move?.(\"AG-1\", \"Human Review\");",
        "    return `mutation AgentOSIssueMove { issueUpdate { success } }`;",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("direct tracker lifecycle write"),
      code: 1
    });
    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("GraphQL mutation string"),
      code: 1
    });
    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("Linear writer integration directly"),
      code: 1
    });
  });

  it("reports direct tracker writes inside old lifecycle helper compatibility paths", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-helper-write-"));
    await writeArchitectureFixture(repo);
    await writeFile(
      join(repo, "src", "orchestrator.ts"),
      [
        "export class Orchestrator {",
        "  private tracker = {} as { move?: (issue: string, state: string) => Promise<void>; comment?: (issue: string, body: string) => Promise<void>; upsertComment?: (issue: string, body: string, key: string) => Promise<void> };",
        "  private async moveIssue(issue: { identifier: string }, stateName: string | null) {",
        "    if (!stateName || !this.tracker.move) return;",
        "    await this.tracker.move(issue.identifier, stateName);",
        "  }",
        "  private async commentIssue(issue: { identifier: string }, body: string, key?: string) {",
        "    if (!this.tracker.comment && !this.tracker.upsertComment) return;",
        "    await (key && this.tracker.upsertComment ? this.tracker.upsertComment(issue.identifier, body, key) : this.tracker.comment!(issue.identifier, body));",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringMatching(/direct tracker lifecycle write[\s\S]*direct tracker lifecycle writes are forbidden in core scheduler code/),
      code: 1
    });
  });

  it("reports lifecycle controller imports of extension implementations", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-architecture-controller-import-"));
    await writeArchitectureFixture(repo);
    await writeFile(
      join(repo, "src", "lifecycle-controller.ts"),
      [
        'import { evaluateReviewBudget } from "./review-budget.js";',
        "export const controller = evaluateReviewBudget;"
      ].join("\n"),
      "utf8"
    );

    await expect(execNode(architectureScript, repo)).rejects.toMatchObject({
      stderr: expect.stringMatching(/src\/lifecycle-controller\.ts imports disallowed review implementation/),
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

  it("reports disabled lifecycle modes in public docs and templates", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-docs-legacy-lifecycle-fail-"));
    await writeDocsFixture(repo);
    await mkdir(join(repo, "templates", "base-harness"), { recursive: true });
    await writeFile(join(repo, "templates", "base-harness", "WORKFLOW.md"), "Use hybrid lifecycle mode.\n", "utf8");

    await expect(execNode(docsScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("disabled public lifecycle mode"),
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

  it("keeps live E2E certification gated and discoverable", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
    const script = await readFile("scripts/certification-e2e.sh", "utf8");

    expect(packageJson.scripts["certification:e2e"]).toBe("bash scripts/certification-e2e.sh");
    expect(script).toContain("AGENT_OS_CERTIFICATION_LIVE");
    expect(script).toContain("AGENT_OS_CERTIFICATION_ACK");
    expect(script).toContain("linear doctor");
    expect(script).toContain("orchestrator once");

    await expect(execShell("bash", ["scripts/certification-e2e.sh"], process.cwd())).resolves.toMatchObject({
      stdout: expect.stringContaining("AgentOS live E2E certification skipped.")
    });
  });

  it("keeps agent-owned certification and traceability gates discoverable", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };

    expect(packageJson.scripts["check:traceability"]).toBe("node scripts/check-traceability.mjs");
    expect(packageJson.scripts["certification:agent-owned"]).toBe("node scripts/certification-agent-owned.mjs");
    await expect(execNode(traceabilityScript, process.cwd())).resolves.toMatchObject({ stdout: expect.stringContaining("Traceability check passed.") });
    await expect(execNode(agentOwnedCertificationScript, process.cwd())).resolves.toMatchObject({ stdout: expect.stringContaining("Agent-owned core certification passed.") });
  });

  it("accepts a minimal traceability fixture", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-traceability-pass-"));
    await writeTraceabilityFixture(repo);

    await expect(execNode(traceabilityScript, repo)).resolves.toMatchObject({ stdout: expect.stringContaining("Traceability check passed.") });
  });

  it("reports malformed traceability rows with remediation guidance", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-traceability-fail-"));
    await writeTraceabilityFixture(repo);
    await writeFile(join(repo, "docs", "releases", "CERTIFICATION_TRACEABILITY.md"), traceabilityMarkdown({ classification: "mystery", proof: "TBD" }), "utf8");

    await expect(execNode(traceabilityScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown classification"),
      code: 1
    });
    await expect(execNode(traceabilityScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("unfinished proof command"),
      code: 1
    });
  });

  it("reports missing traceability evidence paths", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-traceability-missing-path-"));
    await writeTraceabilityFixture(repo);
    await rm(join(repo, "src", "core.ts"));

    await expect(execNode(traceabilityScript, repo)).rejects.toMatchObject({
      stderr: expect.stringContaining("references missing code path"),
      code: 1
    });
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
  await writeFile(
    join(repo, "src", "types.ts"),
    [
      "export interface Issue { id: string; identifier: string }",
      "export interface IssueComment { id: string; body: string }",
      "export interface IssueTracker {",
      "  fetchCandidates(activeStates: string[]): Promise<Issue[]>;",
      "  fetchIssueStates(issueIds: string[]): Promise<Map<string, Issue | null>>;",
      "  fetchTerminalIssues?(terminalStates: string[]): Promise<Issue[]>;",
      "  fetchIssueComments?(issueIdentifierOrId: string, limit?: number): Promise<IssueComment[]>;",
      "  comment?(issueIdentifierOrId: string, body: string): Promise<void>;",
      "  upsertComment?(issueIdentifierOrId: string, body: string, key: string): Promise<void>;",
      "  move?(issueIdentifierOrId: string, stateName: string): Promise<void>;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repo, "src", "tracker-boundaries.ts"),
    [
      'import type { IssueTracker } from "./types.js";',
      'export interface TrackerReader { fetchCandidates: IssueTracker["fetchCandidates"]; fetchIssueStates: IssueTracker["fetchIssueStates"]; fetchTerminalIssues?: IssueTracker["fetchTerminalIssues"]; fetchIssueComments?: IssueTracker["fetchIssueComments"]; }',
      'export interface TrackerLifecycleWriter { comment?: IssueTracker["comment"]; upsertComment?: IssueTracker["upsertComment"]; move?: IssueTracker["move"]; }',
      "export interface TrackerCapabilities extends TrackerReader, TrackerLifecycleWriter {}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repo, "src", "lifecycle-events.ts"),
    [
      'export const lifecycleActors = ["agent", "scheduler_safety", "extension", "supervisor"] as const;',
      "export type LifecycleActor = (typeof lifecycleActors)[number];",
      'export const lifecycleEventTypes = ["run_started", "progress_comment", "pr_metadata_recorded", "handoff_recorded", "state_transition_requested", "review_ready", "scheduler_safety_write_requested", "evidence_verification_failed"] as const;',
      "export type LifecycleEventType = (typeof lifecycleEventTypes)[number];",
      'export const lifecycleEventSources = ["orchestrator", "repo_tool", "client_tool", "extension", "supervisor"] as const;',
      "export type LifecycleEventSource = (typeof lifecycleEventSources)[number];",
      'export const schedulerSafetyWriteReasons = ["bootstrap_failed_before_agent_start", "pre_dispatch_safety_block", "retry_budget_exhausted", "stale_run_recovery_required", "terminal_cleanup_reconciliation", "agent_owned_lifecycle_missing_evidence"] as const;',
      "export type SchedulerSafetyWriteReason = (typeof schedulerSafetyWriteReasons)[number];",
      "export interface LifecycleEvent { schemaVersion: 1; actor: LifecycleActor; type: LifecycleEventType; issueId: string; issueIdentifier: string; source: LifecycleEventSource; createdAt: string; requestedState?: string; commentBody?: string; commentKey?: string; commentKind?: 'bookkeeping' | 'substantive'; }",
      'export type LifecycleTrackerUpdateResult = "applied" | "unsupported" | "failed" | "blocked";',
      "export interface LifecycleControllerRecordResult { trackerUpdateResult?: LifecycleTrackerUpdateResult }",
      "export interface LifecycleController { record(event: LifecycleEvent): Promise<LifecycleControllerRecordResult>; }"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repo, "src", "lifecycle-controller.ts"),
    [
      'import type { LifecycleController, LifecycleControllerRecordResult, LifecycleEvent } from "./lifecycle-events.js";',
      "export class TrackerLifecycleController implements LifecycleController {",
      "  async record(_event: LifecycleEvent): Promise<LifecycleControllerRecordResult> {",
      "    return {};",
      "  }",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(repo, "src", "orchestrator.ts"),
    [
      'import type { LifecycleController } from "./lifecycle-events.js";',
      "export class Orchestrator {",
      "  private lifecycleController = {} as LifecycleController;",
      "  private async moveIssue(issue: { identifier: string }, stateName: string | null) {",
      "    if (!stateName) return;",
      "    await this.lifecycleController.record({ schemaVersion: 1, actor: 'extension', type: 'state_transition_requested', issueId: issue.identifier, issueIdentifier: issue.identifier, source: 'orchestrator', requestedState: stateName, createdAt: new Date().toISOString() });",
      "  }",
      "  private async commentIssue(issue: { identifier: string }, body: string, key?: string) {",
      "    await this.lifecycleController.record({ schemaVersion: 1, actor: 'extension', type: 'progress_comment', issueId: issue.identifier, issueIdentifier: issue.identifier, source: 'orchestrator', commentBody: body, commentKey: key, createdAt: new Date().toISOString() });",
      "  }",
      "  async run() { return true; }",
      "}"
    ].join("\n"),
    "utf8"
  );
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
    "docs/architecture/ORCHESTRATOR_RESPONSIBILITIES.md",
    "docs/decisions/README.md",
    "docs/decisions/0002-optional-extension-boundaries.md",
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
    "docs/releases/CERTIFICATION_TRACEABILITY.md",
    "docs/releases/agent-owned-core-certification.json",
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
      text = "pre-dispatch reconciliation\nrecoverable partial work\ndaemon liveness\nExisting Implementation Audit\ncheck:architecture\ncheck:docs\ncheck:traceability\ndocs/releases/CERTIFICATION_TRACEABILITY.md\ndocs/decisions/0002-optional-extension-boundaries.md\n";
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

async function writeTraceabilityFixture(repo: string): Promise<void> {
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "tests"), { recursive: true });
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(join(repo, "docs", "releases"), { recursive: true });
  await writeFile(join(repo, "src", "core.ts"), "export const core = true;\n", "utf8");
  await writeFile(join(repo, "tests", "core.test.ts"), "import { it } from 'vitest';\nit(\"covers certification scenario\", () => {});\n", "utf8");
  await writeFile(join(repo, "scripts", "certification-e2e.sh"), "#!/usr/bin/env bash\n", "utf8");
  await writeFile(join(repo, "docs", "releases", "CERTIFICATION_TRACEABILITY.md"), traceabilityMarkdown(), "utf8");
  await writeFile(join(repo, "docs", "releases", "agent-owned-core-certification.json"), JSON.stringify(traceabilityCertificationFixture(), null, 2), "utf8");
}

function traceabilityMarkdown(options: { classification?: string; proof?: string } = {}): string {
  const classification = options.classification ?? "core";
  const proof = options.proof ?? "npm test -- tests/core.test.ts --reporter verbose";
  const rows = [
    ["VER-128", "PR #102", classification, "Boundary interfaces", "`src/core.ts`", "`tests/core.test.ts`", proof, "Complete"],
    ["VER-129", "PR #103", "core", "Lifecycle extraction", "`src/core.ts`", "`tests/core.test.ts`", proof, "Complete"],
    ["VER-130", "PR #104", "core", "Lifecycle tooling", "`src/core.ts`", "`tests/core.test.ts`", proof, "Complete"],
    ["VER-131", "PR #105", "core", "Evidence verification", "`src/core.ts`", "`tests/core.test.ts`", proof, "Complete"],
    ["VER-132", "PR #106", "core", "Default flip", "`src/core.ts`", "`tests/core.test.ts`", proof, "Complete"],
    ["VER-133", "PR #107", "legacy", "Legacy fixture exclusion", "`src/core.ts`", "`tests/core.test.ts`", proof, "Complete"],
    ["VER-106", "PR #99", "extension", "Optional extension", "`src/core.ts`", "`tests/core.test.ts`", proof, "Complete"],
    ["VER-134", "branch: codex/ver-134-agent-owned-certification", "core", "Certification", "`src/core.ts`", "`tests/core.test.ts`", "npm run check:traceability && npm run certification:agent-owned", "Complete"],
    ["VER-134", "live-e2e: credential-gated", "live-e2e", "Live proof", "`scripts/certification-e2e.sh`", "`tests/core.test.ts`", "npm run certification:e2e", "Gated"]
  ];
  return [
    "# Certification Traceability",
    "",
    "| Linear issue | PR/branch | Classification | Acceptance focus | Code path | Test or artifact | Proof command | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

function traceabilityCertificationFixture(): unknown {
  const evidence = [{ path: "tests/core.test.ts", testName: "covers certification scenario" }];
  const proofCommands = ["npm test -- tests/core.test.ts --reporter verbose"];
  return {
    schemaVersion: 1,
    certificationIssue: "VER-134",
    status: "certified",
    lifecycleMode: "agent-owned",
    refactorIssues: ["VER-128", "VER-129", "VER-130", "VER-131", "VER-132", "VER-133", "VER-134"].map((id) => ({
      id,
      prOrBranch: id === "VER-134" ? "branch: codex/ver-134-agent-owned-certification" : "PR #100",
      classification: id === "VER-133" ? "legacy" : "core"
    })),
    legacyPolicy: {
      excludedFromCoreCertification: true,
      ver134BlockerUnlessRemoved: true
    },
    scenarios: [
      "no-pr-already-satisfied",
      "one-pr-implementation",
      "multi-pr-handoff-roles-preserved",
      "missing-evidence-path",
      "restart-recovery-across-evidence-steps",
      "all-scheduler-safety-reasons",
      "extension-routing-through-lifecycle-adapters",
      "raw-graphql-opt-in-only",
      "app-legibility-proof"
    ].map((id) => ({
      id,
      status: "covered",
      classification: id === "extension-routing-through-lifecycle-adapters" || id === "raw-graphql-opt-in-only" ? "extension" : "core",
      evidence,
      proofCommands
    }))
  };
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
  return execShell(process.execPath, [script], cwd);
}

function execShell(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr, code: error.code }));
        return;
      }
      resolvePromise({ stdout, stderr, code: 0 });
    });
  });
}
