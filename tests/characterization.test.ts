import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { issueStateFromHandoff } from "../src/issue-state.js";
import { JsonlLogger } from "../src/logging.js";
import { Orchestrator } from "../src/orchestrator.js";
import { loadWorkflow, resolveServiceConfig } from "../src/workflow.js";
import { fakeIssue, FakeRunner, FakeTracker, writePassingHandoff } from "./fixtures/agentos-fakes.js";

describe("current AgentOS characterization", () => {
  it("captures current workflow defaults targeted by hardening", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-character-workflow-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(workflowPath, "---\ntracker:\n  api_key: $LINEAR_API_KEY\n  project_slug: AgentOS\n---\nDo work", "utf8");

    const workflow = await loadWorkflow(workflowPath);
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });

    expect(config.trustMode).toBe("ci-locked");
    expect(config.codex.command).toBe("npx -y @openai/codex@0.125.0 app-server");
    expect(config.codex.approvalEventPolicy).toBe("deny");
    expect(config.codex.userInputPolicy).toBe("deny");
    expect(config.codex.turnSandboxPolicy).toMatchObject({ type: "workspaceWrite", networkAccess: false });
    expect(config.github.mergeMode).toBe("manual");
    expect(config.github.allowHumanMergeOverride).toBe(false);
    expect(config.github.mergeMethod).toBe("squash");
    expect(config.github.requireChecks).toBe(true);
  });

  it("captures multi-PR handoff parsing behavior", () => {
    const issue = fakeIssue({ state: "Human Review" });
    const state = issueStateFromHandoff(
      issue,
      [
        "AgentOS-Outcome: implemented",
        "",
        "PR: https://github.com/o/r/pull/1",
        "Follow-up PR: https://github.com/o/r/pull/2"
      ].join("\n")
    );

    expect(state).toMatchObject({
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      prUrl: "https://github.com/o/r/pull/1",
      prs: [
        { url: "https://github.com/o/r/pull/1", source: "handoff" },
        { url: "https://github.com/o/r/pull/2", source: "handoff" }
      ],
      reviewStatus: "pending"
    });
  });

  it("captures current orchestrator global event log shape", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-character-orch-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      [
        "---",
        "tracker:",
        "  kind: linear",
        "  api_key: $LINEAR_API_KEY",
        "  project_slug: AgentOS",
        "  active_states: [Ready]",
        "workspace:",
        "  root: .agent-os/workspaces",
        "agent:",
        "  max_turns: 1",
        "review:",
        "  enabled: false",
        "---",
        "Do {{ issue.identifier }}"
      ].join("\n"),
      "utf8"
    );

    const issue = fakeIssue();
    const tracker = new FakeTracker([issue], new Map([[issue.id, issue]]));
    const runner = new FakeRunner(async (workspace, input) => {
      await writePassingHandoff(workspace, issue.identifier, input.prompt, "AgentOS-Outcome: already-satisfied\n\nValidation: characterized.");
      return { status: "succeeded" };
    });
    const logger = new JsonlLogger(repo);

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner,
      logger,
      env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
    }).runOnce(true);

    const log = await readFile(join(repo, ".agent-os", "runs", "agent-os.jsonl"), "utf8");
    const entries = log.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries.some((entry) => entry.type === "run_started" && entry.issueIdentifier === "AG-1")).toBe(true);
    expect(entries.some((entry) => entry.type === "run_succeeded" && entry.issueIdentifier === "AG-1")).toBe(true);
    expect(entries.every((entry) => !("schemaVersion" in entry))).toBe(true);
    const runId = entries.find((entry) => entry.type === "run_started")?.runId;
    expect(runId).toMatch(/^run_/);
    const summary = JSON.parse(await readFile(join(repo, ".agent-os", "runs", String(runId), "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      schemaVersion: 1,
      runId,
      issueIdentifier: "AG-1",
      status: "succeeded"
    });
    expect(tracker.moves.map((move) => `${move.issue} -> ${move.state}`)).toEqual(["AG-1 -> In Progress", "AG-1 -> Human Review"]);
  });

  it("captures current worktree bootstrap branch reuse behavior", async () => {
    const script = await readFile(resolve("scripts/agent-bootstrap-worktree.sh"), "utf8");

    expect(script).toContain('branch="agent/${workspace_key}"');
    expect(script).toContain("Refusing to create AgentOS workspace from a dirty source worktree.");
    expect(script).toContain('git -C "$source_repo" worktree add -B "$branch" "$workspace" HEAD');
    expect(script).not.toContain("AGENT_OS_RUN_ID");
    expect(script).not.toContain("lock");
  });
});
