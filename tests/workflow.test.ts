import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
    expect(config.automation).toMatchObject({
      profile: "conservative",
      repairPolicy: "conservative"
    });
    expect(config.lifecycle).toMatchObject({
      mode: "agent-owned",
      allowedTrackerTools: [],
      clientTrackerTools: [],
      idempotencyMarkerFormat: null,
      allowedStateTransitions: [],
      duplicateCommentBehavior: null,
      fallbackBehavior: null,
      maturityAcknowledgement: null
    });
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
      markDraftReady: false,
      deleteBranch: true,
      doneState: "Done",
      allowHumanMergeOverride: false,
      mergeTarget: "primary",
      baseBranch: "main"
    });
    expect(config.daemon).toMatchObject({
      mainBranchRefreshIntervalTicks: 5
    });
    expect(config.server).toEqual({ port: null, host: "127.0.0.1" });
    expect(config.modelRouting).toEqual({ mode: "off", roles: {} });
    expect(config.review).toMatchObject({
      enabled: true,
      targetMode: "merge-eligible",
      maxIterations: 3,
      requiredReviewers: ["self", "correctness", "tests", "architecture"],
      optionalReviewers: ["security"],
      requireAllBlockingResolved: true,
      blockingSeverities: ["P0", "P1", "P2"],
      parallelReviewers: false,
      maxConcurrentReviewers: 1,
      skipOptionalReviewersAfterBlockingRequired: false,
      budget: expect.objectContaining({
        enabled: true,
        mode: "recommend-only",
        maxChangedFiles: 40,
        repeatedBroadCategoryThreshold: 2
      })
    });
    expect(config.workspace.root).toContain(".agent-os/workspaces");

    const strictValidation = validateWorkflowDefinition(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true);
    expect(strictValidation.errors).toEqual(
      expect.arrayContaining([
        "lifecycle.mode=agent-owned requires lifecycle.allowed_tracker_tools in strict mode",
        "lifecycle.mode=agent-owned requires lifecycle.idempotency_marker_format in strict mode",
        "lifecycle.mode=agent-owned requires lifecycle.allowed_state_transitions in strict mode",
        "lifecycle.mode=agent-owned requires lifecycle.duplicate_comment_behavior in strict mode",
        "lifecycle.mode=agent-owned requires lifecycle.fallback_behavior in strict mode"
      ])
    );
  });

  it("resolves relative workspace roots from the selected workflow directory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-dir-"));
    const workflowDir = join(repo, "config", "agentos");
    const workflowPath = join(workflowDir, "WORKFLOW.md");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\nworkspace:\n  root: ../runtime/workspaces\n---\nHello`,
      "utf8"
    );

    const workflow = await loadWorkflow(workflowPath);
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });

    expect(config.workspace.root).toBe(resolve(workflowDir, "../runtime/workspaces"));
  });

  it("parses optional loopback server config", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-server-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\nserver:\n  port: 4317\n  host: 127.0.0.1\n---\nHello`,
      "utf8"
    );
    const workflow = await loadWorkflow(workflowPath);
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    expect(config.server).toEqual({ port: 4317, host: "127.0.0.1" });
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
        "lifecycle:",
        "  mode: agent-owned",
        "  allowed_tracker_tools:",
        "    - scripts/agent-linear-comment.sh",
        "    - scripts/agent-linear-move.sh",
        "    - scripts/agent-linear-pr.sh",
        "    - scripts/agent-linear-handoff.sh",
        "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
        "  allowed_state_transitions:",
        "    - Todo -> In Progress",
        "    - In Progress -> Human Review",
        "  duplicate_comment_behavior: upsert",
        "  fallback_behavior: write handoff and stop human_required",
        "codex:",
        "  command: npx -y @openai/codex@0.125.0 app-server",
        "github:",
        "  merge_mode: manual",
        "  mark_draft_ready: true",
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

  it("keeps the checked-in workflow strict-clean", async () => {
    const workflow = await loadWorkflow("WORKFLOW.md");
    const text = await readFile("WORKFLOW.md", "utf8");

    expect(validateWorkflowDefinition(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true)).toMatchObject({
      ok: true,
      errors: []
    });
    expect(text).not.toContain("No npm lint script found");
    expect(text).not.toContain("No dedicated coverage script found");
    expect(text).not.toContain("No explicit formatting check script found");
  });

  it("rejects unknown tracker kinds with registered adapter guidance", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-tracker-kind-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      ["---", "tracker:", "  kind: jira", "  api_key: token", "  project_slug: AgentOS", "---", "Do work"].join("\n"),
      "utf8"
    );

    const workflow = await loadWorkflow(workflowPath);
    expect(validateWorkflowDefinition(workflow, { HOME: "/tmp" }, true).errors[0]).toMatch(/unsupported_tracker_kind: jira; registered adapters: .*linear/);
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

  it("parses report-only model routing by role", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-model-routing-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "model_routing:",
        "  mode: report-only",
        "  roles:",
        "    tests-review:",
        "      model: gpt-5.4-mini",
        "      reasoning_effort: low",
        "      cost_bucket: low",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );

    const config = resolveServiceConfig(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    expect(config.modelRouting).toMatchObject({
      mode: "report-only",
      roles: {
        "tests-review": {
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          costBucket: "low"
        }
      }
    });
  });

  it("parses automation behavior as a separate axis from trust and lifecycle", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-automation-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "trust_mode: ci-locked",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: agent-owned",
        "  allowed_tracker_tools:",
        "    - scripts/agent-linear-comment.sh",
        "    - scripts/agent-linear-move.sh",
        "    - scripts/agent-linear-pr.sh",
        "    - scripts/agent-linear-handoff.sh",
        "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
        "  allowed_state_transitions:",
        "    - Todo -> In Progress",
        "    - In Progress -> Human Review",
        "  duplicate_comment_behavior: upsert",
        "  fallback_behavior: write handoff and stop human_required",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "codex:",
        "  command: npx -y @openai/codex@0.125.0 app-server",
        "  approval_event_policy: deny",
        "  user_input_policy: deny",
        "github:",
        "  merge_mode: manual",
        "  mark_draft_ready: true",
        "  allow_human_merge_override: false",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );

    const workflow = await loadWorkflow(workflowPath);
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    expect(config.automation).toEqual({ profile: "high-throughput", repairPolicy: "mechanical-first" });
    expect(config.trustMode).toBe("ci-locked");
    expect(config.lifecycle.mode).toBe("agent-owned");
    expect(config.codex.approvalEventPolicy).toBe("deny");
    expect(config.codex.userInputPolicy).toBe("deny");
    expect(config.github.markDraftReady).toBe(true);

    expect(validateWorkflowDefinition(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true)).toMatchObject({
      ok: true,
      errors: []
    });
  });

  it("parses opt-in reviewer parallelism controls", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-review-parallel-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "review:",
        "  parallel_reviewers: true",
        "  max_concurrent_reviewers: 3",
        "  skip_optional_reviewers_after_blocking_required: true",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );

    const workflow = await loadWorkflow(workflowPath);
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    expect(config.review).toMatchObject({
      parallelReviewers: true,
      maxConcurrentReviewers: 3,
      skipOptionalReviewersAfterBlockingRequired: true
    });
  });

  it("parses review budget controls", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-review-budget-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "review:",
        "  max_iterations: 4",
        "  budget:",
        "    mode: prepare-draft",
        "    max_review_elapsed_ms: 1000",
        "    max_changed_files: 8",
        "    max_fixer_iterations: 1",
        "    broad_categories: [architecture, lifecycle]",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );

    const workflow = await loadWorkflow(workflowPath);
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    expect(config.review.budget).toMatchObject({
      mode: "prepare-draft",
      maxReviewElapsedMs: 1000,
      maxChangedFiles: 8,
      maxFixerIterations: 1,
      maxReviewIterations: 4,
      broadCategories: ["architecture", "lifecycle"]
    });
  });

  it("parses context and validation budget controls", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-budget-controls-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "context_budget:",
        "  max_prompt_tokens: 5000",
        "  max_cumulative_tokens: 12000",
        "  large_section_tokens: 1000",
        "validation_budget:",
        "  full_validation_command: npm run agent-check",
        "  max_full_validation_runs_per_head: 1",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );

    const config = resolveServiceConfig(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    expect(config.contextBudget).toMatchObject({
      enabled: true,
      maxPromptTokens: 5000,
      maxCumulativeTokens: 12000,
      largeSectionTokens: 1000
    });
    expect(config.validationBudget).toMatchObject({
      enabled: true,
      fullValidationCommand: "npm run agent-check",
      maxFullValidationRunsPerHead: 1
    });
  });

  it("rejects invalid automation configs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-automation-invalid-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "automation:",
        "  profile: instant",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain("unsupported_automation_profile: instant");

    await writeFile(
      workflowPath,
      [
        "---",
        "automation:",
        "  repair_policy: unbounded",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain(
      "unsupported_automation_repair_policy: unbounded"
    );
  });

  it("rejects unsupported review and merge target selection values", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-target-invalid-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "review:",
        "  target_mode: primay",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain(
      "unsupported_review_target_mode: primay"
    );

    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "review:",
        "  budget:",
        "    mode: auto-create",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain(
      "unsupported_review_budget_mode: auto-create"
    );

    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "github:",
        "  merge_target: docs",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain(
      "unsupported_github_merge_target: docs"
    );
  });

  it("strictly gates production agent-owned lifecycle mode", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-lifecycle-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "lifecycle:",
        "  mode: agent-owned",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "codex:",
        "  command: npx -y @openai/codex@0.125.0 app-server",
        "github:",
        "  merge_mode: manual",
        "  allow_human_merge_override: false",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );

    const missing = validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true);
    expect(missing.errors).toContain("lifecycle.mode=agent-owned requires lifecycle.allowed_tracker_tools in strict mode");
    expect(missing.errors).toContain("lifecycle.mode=agent-owned requires lifecycle.idempotency_marker_format in strict mode");
    expect(missing.errors).toContain("lifecycle.mode=agent-owned requires lifecycle.allowed_state_transitions in strict mode");
    expect(missing.errors).toContain("lifecycle.mode=agent-owned requires lifecycle.duplicate_comment_behavior in strict mode");
    expect(missing.errors).toContain("lifecycle.mode=agent-owned requires lifecycle.fallback_behavior in strict mode");

    await writeFile(
      workflowPath,
      [
        "---",
        "lifecycle:",
        "  mode: agent-owned",
        "  allowed_tracker_tools:",
        "    - scripts/agent-linear-comment.sh",
        "    - scripts/agent-linear-move.sh",
        "    - scripts/agent-linear-pr.sh",
        "    - scripts/agent-linear-handoff.sh",
        "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
        "  allowed_state_transitions:",
        "    - Todo -> In Progress",
        "    - In Progress -> Human Review",
        "  duplicate_comment_behavior: upsert",
        "  fallback_behavior: write handoff and stop human_required",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "codex:",
        "  command: npx -y @openai/codex@0.125.0 app-server",
        "github:",
        "  merge_mode: manual",
        "  allow_human_merge_override: false",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const configured = validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true);
    expect(configured.errors).toEqual([]);

    await writeFile(
      workflowPath,
      [
        "---",
        "lifecycle:",
        "  mode: agent-owned",
        "  allowed_tracker_tools:",
        "    - scripts/agent-linear-comment.sh",
        "    - scripts/agent-linear-move.sh",
        "    - scripts/agent-linear-pr.sh",
        "    - scripts/agent-linear-handoff.sh",
        "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} -->\"",
        "  allowed_state_transitions:",
        "    - Todo -> Human Review",
        "  duplicate_comment_behavior: upsert",
        "  fallback_behavior: write handoff and stop human_required",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "codex:",
        "  command: npx -y @openai/codex@0.125.0 app-server",
        "github:",
        "  merge_mode: manual",
        "  allow_human_merge_override: false",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const missingCorrelation = validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true);
    expect(missingCorrelation.errors).toContain("lifecycle.idempotency_marker_format must include {run} in strict mode");
    expect(missingCorrelation.errors).toContain("lifecycle.idempotency_marker_format must include {attempt} in strict mode");

    await writeFile(
      workflowPath,
      [
        "---",
        "lifecycle:",
        "  mode: agent-owned",
        "  allowed_tracker_tools:",
        "    - scripts/agent-linear-comment.sh",
        "    - linear_graphql",
        "  idempotency_marker_format: \"<!-- agentos:event={event} issue={issue} run={run} attempt={attempt} -->\"",
        "  allowed_state_transitions:",
        "    - Todo -> Human Review",
        "  duplicate_comment_behavior: upsert",
        "  fallback_behavior: write handoff and stop human_required",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "codex:",
        "  command: npx -y @openai/codex@0.125.0 app-server",
        "github:",
        "  merge_mode: manual",
        "  allow_human_merge_override: false",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const rawGraphqlInAllowlist = validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true);
    expect(rawGraphqlInAllowlist.errors).toContain("linear_graphql must be configured through lifecycle.client_tracker_tools, not lifecycle.allowed_tracker_tools");
  });

  it("keeps root and base template workflows as strict agent-owned defaults", async () => {
    for (const path of ["WORKFLOW.md", "templates/base-harness/WORKFLOW.md"]) {
      const workflow = await loadWorkflow(resolve(path));
      const validation = validateWorkflowDefinition(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }, true);
      const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });

      expect(validation.errors).toEqual([]);
      expect(config.lifecycle.mode).toBe("agent-owned");
      expect(config.lifecycle.allowedTrackerTools).toEqual(
        expect.arrayContaining([
          "scripts/agent-linear-comment.sh",
          "scripts/agent-linear-move.sh",
          "scripts/agent-linear-pr.sh",
          "scripts/agent-linear-handoff.sh"
        ])
      );
      expect(config.lifecycle.idempotencyMarkerFormat).toContain("{event}");
      expect(config.lifecycle.idempotencyMarkerFormat).toContain("{issue}");
      expect(config.lifecycle.idempotencyMarkerFormat).toContain("{run}");
      expect(config.lifecycle.idempotencyMarkerFormat).toContain("{attempt}");
      expect(config.lifecycle.allowedStateTransitions).toEqual(expect.arrayContaining(["Todo -> In Progress", "Todo -> Human Review", "In Progress -> Human Review"]));
      expect(config.lifecycle.duplicateCommentBehavior).toBe("upsert");
      expect(config.lifecycle.fallbackBehavior).toContain("handoff");
      expect(config.lifecycle.fallbackBehavior).toContain("human_required");
      expect(config.lifecycle.clientTrackerTools).not.toContain("linear_graphql");
      expect(workflow.prompt_template).toContain("scripts/agent-linear-comment.sh");
      expect(workflow.prompt_template).toContain("scripts/agent-linear-move.sh");
      expect(workflow.prompt_template).toContain("scripts/agent-linear-pr.sh");
      expect(workflow.prompt_template).toContain("scripts/agent-linear-handoff.sh");
      expect(workflow.prompt_template).toContain("Do not use raw `linear_graphql` unless `lifecycle.client_tracker_tools`");
      expect(workflow.prompt_template).not.toContain("mode: hybrid");
      expect(workflow.prompt_template).not.toContain("mode: orchestrator-owned");
      expect(workflow.prompt_template).not.toContain("`hybrid`");
      expect(workflow.prompt_template).not.toContain("`orchestrator-owned`");
    }
  });

  it("rejects invalid lifecycle configs", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-workflow-lifecycle-invalid-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    for (const legacyMode of ["hybrid", "orchestrator-owned"]) {
      await writeFile(
        workflowPath,
        [
          "---",
          "lifecycle:",
          `  mode: ${legacyMode}`,
          "tracker:",
          "  api_key: $LINEAR_API_KEY",
          "  project_slug: AgentOS",
          "---",
          "Do work"
        ].join("\n"),
        "utf8"
      );
      expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain(
        `legacy_lifecycle_mode_disabled: ${legacyMode}; use agent-owned`
      );
    }

    await writeFile(
      workflowPath,
      [
        "---",
        "lifecycle:",
        "  mode: loose",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain("unsupported_lifecycle_mode: loose");

    await writeFile(
      workflowPath,
      [
        "---",
        "lifecycle:",
        "  mode: agent-owned",
        "  duplicate_comment_behavior: duplicate",
        "tracker:",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    expect(validateWorkflowDefinition(await loadWorkflow(workflowPath), { LINEAR_API_KEY: "lin_test" }).errors).toContain(
      "unsupported_lifecycle_duplicate_comment_behavior: duplicate"
    );
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
      expect(text).toContain("Issues are the unit of work");
      expect(text).toContain("A run may produce zero, one, or many pull requests");
      expect(text).toContain("workflow expects a PR");
      expect(text).not.toContain("Open or update a GitHub PR when code or docs changed and validation passes");
    }
  });

  it("keeps public template automation defaults conservative", async () => {
    const text = await readFile("templates/base-harness/WORKFLOW.md", "utf8");
    expect(text).toContain("automation:");
    expect(text).toContain("profile: conservative");
    expect(text).toContain("repair_policy: conservative");
  });
});
