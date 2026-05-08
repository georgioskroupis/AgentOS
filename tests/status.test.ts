import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RegistryStateStore } from "../src/registry.js";
import { JsonlLogger } from "../src/logging.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { getRegistryStatus, getStatus, inspectDaemonHealth, inspectIssue } from "../src/status.js";

describe("issue inspection", () => {
  it("shows accepted validation commands and failed historical attempts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "review",
          reviewStatus: "human_required",
          appProof: {
            updatedAt: "2026-05-01T00:02:30.000Z",
            artifacts: [{ label: "app-proof", value: ".agent-os/proof/latest-proof.md", source: "handoff" }]
          },
          lastHumanDecision: {
            type: "fix_findings",
            source: "linear-comment",
            actor: "Supervisor",
            decidedAt: "2026-05-01T00:02:45.000Z",
            prHeadSha: "abc123",
            ciState: "pending",
            findings: "open"
          },
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-01T00:00:00.000Z",
            acceptedCommands: [
              {
                name: "npm run agent-check",
                exitCode: 0,
                startedAt: "2026-05-01T00:01:00.000Z",
                finishedAt: "2026-05-01T00:02:00.000Z"
              }
            ],
            failedHistoricalAttempts: [
              {
                name: "npm run agent-check",
                exitCode: 1,
                startedAt: "2026-05-01T00:00:00.000Z",
                finishedAt: "2026-05-01T00:00:10.000Z"
              }
            ]
          },
          updatedAt: "2026-05-01T00:03:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Validation: passed (final: passed)");
    expect(output).toContain("Human decision: fix_findings");
    expect(output).toContain("Decision PR head SHA: abc123");
    expect(output).toContain("App proof: 2026-05-01T00:02:30.000Z");
    expect(output).toContain("app-proof: .agent-os/proof/latest-proof.md");
    expect(output).toContain("Next safe action: redispatch from Todo/In Progress");
    expect(output).toContain("Accepted validation commands:");
    expect(output).toContain("npm run agent-check: exitCode 0");
    expect(output).toContain("Failed historical attempts:");
    expect(output).toContain("npm run agent-check: exitCode 1");
  });

  it("shows registry project health, CI wait state, daemon freshness, and validation timing splits", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-registry-status-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "agent:",
        "  max_concurrent_agents: 2",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(
      registryPath,
      ["version: 1", "defaults:", "  maxConcurrency: 2", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md", "    maxConcurrency: 1"].join("\n"),
      "utf8"
    );
    await new RegistryStateStore(registryPath).write({
      schemaVersion: 1,
      updatedAt: "2026-05-05T00:10:00.000Z",
      cursor: 0,
      globalConcurrency: 2,
      projects: [
        {
          name: "alpha",
          repoRoot: repo,
          workflowPath: join(repo, "WORKFLOW.md"),
          status: "transient_tracker_error",
          checkedAt: "2026-05-05T00:10:00.000Z",
          activeRuns: 0,
          retryQueue: 0,
          claimedIssues: 0,
          maxConcurrency: 1,
          lastSuccessfulTrackerReadAt: "2026-05-05T00:00:00.000Z",
          lastError: "fetch failed",
          errorCategory: "tracker_network"
        }
      ]
    });
    await new RuntimeStateStore(repo).setDaemon({
      startedAt: "2026-05-05T00:00:00.000Z",
      startGitSha: "old",
      startMainGitSha: "old",
      currentGitSha: "new",
      currentMainGitSha: "new",
      workflowPath: join(repo, "WORKFLOW.md"),
      freshnessStatus: "main_advanced",
      freshnessMessage: "main advanced from old to new; restart required",
      preflightStatus: "missing_credentials",
      preflightMessage: "tracker.api_key is required after environment resolution",
      repoEnvPath: join(repo, ".agent-os", "env"),
      repoEnvStatus: "missing"
    });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "completed",
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-05T00:06:00.000Z", finishedAt: "2026-05-05T00:07:00.000Z" }],
            additionalPassingCommands: [
              { name: "npm test -- tests/runner.test.ts tests/agent-lifecycle-cli.test.ts", exitCode: 0, startedAt: "2026-05-05T00:03:00.000Z", finishedAt: "2026-05-05T00:04:00.000Z" }
            ],
            failedHistoricalAttempts: [{ name: "npm run agent-check", exitCode: 1, startedAt: "2026-05-05T00:01:00.000Z", finishedAt: "2026-05-05T00:02:00.000Z" }],
            githubCi: { status: "passed", headSha: "abc123", checkedAt: "2026-05-05T00:05:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-2.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-2",
          issueIdentifier: "AG-2",
          phase: "merge",
          reviewStatus: "approved",
          workspacePath: ".agent-os/workspaces/AG-2",
          headSha: "abc123",
          prs: [{ url: "https://github.com/o/r/pull/2", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            githubCi: { status: "pending", headSha: "abc123", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-3.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-3",
          issueIdentifier: "AG-3",
          phase: "completed",
          headSha: "def456",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            githubCi: { status: "passed", headSha: "def456", checkedAt: "2026-05-05T00:08:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new JsonlLogger(repo).write({
      type: "merge_waiting",
      issueId: "issue-2",
      issueIdentifier: "AG-2",
      message: "1 GitHub check(s) still pending"
    });

    const output = await getRegistryStatus(registryPath);

    expect(output).toContain("alpha: transient_tracker_error");
    expect(output).toContain("Config: trust=danger; lifecycle=orchestrator-owned; automation=high-throughput/mechanical-first");
    expect(output).toContain("Error: tracker_network - fetch failed");
    expect(output).toContain("Daemon: main_advanced - main advanced from old to new; restart required");
    expect(output).toContain("Daemon preflight: missing_credentials - tracker.api_key is required after environment resolution");
    expect(output).toContain("Repo env: missing");
    expect(output).toContain("AG-2: waiting on CI - 1 GitHub check(s) still pending");
    expect(output).toContain("AG-3: completed locally");
    expect(output).not.toContain("AG-2: status warning");
    expect(output).not.toContain("AG-3: status warning");
    expect(output).toContain("AG-1: local full-suite validation timing failure recorded separately; focused test passed; GitHub CI passed at abc123");
  });

  it("reports daemon liveness states and status next safe actions", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-daemon-health-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });

    const stopped = await getStatus(repo);
    expect(stopped).toContain("Daemon: stopped - no daemon PID file is present");
    expect(stopped).toContain("Next safe action: mkdir -p .agent-os");

    await writeFile(join(repo, ".agent-os", "daemon.pid"), "999999\n", "utf8");
    await writeFile(join(repo, ".agent-os", "daemon.log"), "", "utf8");
    const failed = await inspectDaemonHealth(repo);
    expect(failed.status).toBe("failed_launch");
    expect(failed.nextSafeAction).toContain("remove");
    expect(failed.nextSafeAction).toContain(".agent-os/daemon.pid");

    await writeFile(join(repo, ".agent-os", "daemon.pid"), `${process.pid}\n`, "utf8");
    await new RuntimeStateStore(repo).setDaemon({
      startedAt: "2026-05-05T00:00:00.000Z",
      workflowPath: join(repo, "WORKFLOW.md"),
      preflightStatus: "ready",
      preflightMessage: "loaded repo env",
      repoEnvPath: join(repo, ".agent-os", "env"),
      repoEnvStatus: "loaded"
    });
    const healthy = await inspectDaemonHealth(repo);
    expect(healthy.status).toBe("healthy");
    expect(healthy.message).toContain("credential preflight is ready");
    expect(healthy.nextSafeAction).toContain("no operator action required");
  });

  it("shows recoverable partial work, stale PR heads, stale CI heads, and one next action", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-recovery-"));
    const workspace = join(repo, ".agent-os", "workspaces", "AG-1");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await run("git", ["init", "-b", "main"], workspace);
    await run("git", ["config", "user.email", "agentos@example.test"], workspace);
    await run("git", ["config", "user.name", "AgentOS Test"], workspace);
    await writeFile(join(workspace, "README.md"), "initial\n", "utf8");
    await run("git", ["add", "README.md"], workspace);
    await run("git", ["commit", "-m", "initial"], workspace);
    await writeFile(join(workspace, "README.md"), "dirty local fix\n", "utf8");

    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "needs-input",
          reviewStatus: "human_required",
          lastError: "codex_stall_timeout",
          workspacePath: workspace,
          headSha: "recorded-pr-head",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:00:00.000Z",
            githubCi: { status: "failed", headSha: "ci-head", checkedAt: "2026-05-05T00:00:00.000Z" }
          },
          updatedAt: "2026-05-05T00:00:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Workspace recovery: recoverable partial work");
    expect(output).toContain("workspace has uncommitted changes");
    expect(output).toContain("branch has no upstream");
    expect(output).toContain("differs from recorded PR head recorded-pr-head");
    expect(output).toContain("differs from recorded CI head ci-head");
    expect(output).toContain(`Next safe action: resume ${workspace}`);
  });

  it("reports terminal-state contradictions and post-merge cleanup drift as status warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-terminal-drift-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-3.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-3",
          issueIdentifier: "AG-3",
          phase: "completed",
          lifecycleStatus: "post_merge_cleanup_warning",
          terminalState: "Done",
          terminalAt: "2026-05-05T00:10:00.000Z",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "human_required",
          lastError: "codex_stall_timeout",
          errorCategory: "stall",
          retryAttempt: 2,
          nextRetryAt: "2026-05-05T00:20:00.000Z",
          workspacePath: ".agent-os/workspaces/AG-3",
          headSha: "new-head-sha",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "failed", headSha: "old-ci-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          mergeCleanupWarnings: [
            "Local branch cleanup failed for agent/AG-3: branch is checked out at /tmp/worktree",
            "Remote branch cleanup failed for agent/AG-3: remote rejected delete"
          ],
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-3: status warning - contradictory terminal state: terminal issue still has reviewStatus human_required");

    const inspectOutput = await inspectIssue(repo, "AG-3");
    expect(inspectOutput).toContain("Status warnings:");
    expect(inspectOutput).toContain("contradictory terminal state: terminal issue still has reviewStatus human_required");
    expect(inspectOutput).toContain("stale error metadata remains (stall) - codex_stall_timeout");
    expect(inspectOutput).toContain("stale validation/CI head SHA old-ci-sha differs from recorded head new-head-sha");
    expect(inspectOutput).toContain("terminal issue still records GitHub CI as failed");
    expect(inspectOutput).toContain("merge/retry drift: terminal issue still has retry metadata for 2026-05-05T00:20:00.000Z");
    expect(inspectOutput).toContain("post-merge cleanup drift: selected PR is merged but AgentOS branch cleanup warning remains");
    expect(inspectOutput).toContain("Next safe action: verify the terminal PR/Linear evidence");
    expect(inspectOutput).not.toContain("record `AgentOS-Human-Decision: fix-findings`");
  });

  it("reports completed local state contradictions even without explicit terminal metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-completed-local-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-4.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-4",
          issueIdentifier: "AG-4",
          phase: "completed",
          reviewStatus: "human_required",
          lastError: "codex_stall_timeout",
          errorCategory: "stall",
          workspacePath: ".agent-os/workspaces/AG-4",
          headSha: "new-head-sha",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "failed", headSha: "old-ci-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-4: status warning - contradictory terminal state: terminal issue still has reviewStatus human_required");

    const output = await inspectIssue(repo, "AG-4");

    expect(output).toContain("Status warnings:");
    expect(output).toContain("contradictory terminal state: terminal issue still has reviewStatus human_required");
    expect(output).toContain("stale error metadata remains (stall) - codex_stall_timeout");
    expect(output).toContain("stale validation/CI head SHA old-ci-sha differs from recorded head new-head-sha");
    expect(output).toContain("terminal issue still records GitHub CI as failed");
    expect(output).toContain("missing terminal workspace warning");
    expect(output).toContain("Next safe action: verify the terminal PR/Linear evidence");
    expect(output).not.toContain("record `AgentOS-Human-Decision: fix-findings`");
  });

  it("does not warn when clean post-merge cleanup removed the recorded workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-status-clean-merge-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(registryPath, ["version: 1", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md"].join("\n"), "utf8");
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-5.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-5",
          issueIdentifier: "AG-5",
          phase: "completed",
          lifecycleStatus: "merge_success",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "approved",
          workspacePath: ".agent-os/workspaces/AG-5",
          headSha: "merged-head-sha",
          prs: [{ url: "https://github.com/o/r/pull/5", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          mergeTargetUrl: "https://github.com/o/r/pull/5",
          mergeTargetRole: "primary",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "passed", headSha: "merged-head-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-6.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-6",
          issueIdentifier: "AG-6",
          phase: "completed",
          lifecycleStatus: "already_merged_pr",
          mergedAt: "2026-05-05T00:10:00.000Z",
          reviewStatus: "approved",
          workspacePath: ".agent-os/workspaces/AG-6",
          headSha: "merged-head-sha",
          prs: [{ url: "https://github.com/o/r/pull/6", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          mergeTargetUrl: "https://github.com/o/r/pull/6",
          mergeTargetRole: "primary",
          validation: {
            status: "passed",
            checkedAt: "2026-05-05T00:09:00.000Z",
            githubCi: { status: "passed", headSha: "merged-head-sha", checkedAt: "2026-05-05T00:09:00.000Z" }
          },
          updatedAt: "2026-05-05T00:10:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const registryOutput = await getRegistryStatus(registryPath);
    expect(registryOutput).toContain("AG-5: merged");
    expect(registryOutput).toContain("AG-6: already merged");
    expect(registryOutput).not.toContain("AG-5: waiting on merge");
    expect(registryOutput).not.toContain("AG-6: waiting on merge");
    expect(registryOutput).not.toContain("AG-5: status warning");
    expect(registryOutput).not.toContain("AG-6: status warning");

    const inspectOutput = await inspectIssue(repo, "AG-5");
    expect(inspectOutput).toContain("Status warnings: none");
    expect(inspectOutput).toContain("Next safe action: no operator action required; selected PR is merged and terminal state is recorded");
    expect(inspectOutput).not.toContain("move the issue to Merging");
    expect(inspectOutput).not.toContain("missing terminal workspace warning");

    const alreadyMergedOutput = await inspectIssue(repo, "AG-6");
    expect(alreadyMergedOutput).toContain("Status warnings: none");
    expect(alreadyMergedOutput).toContain("Next safe action: no operator action required; selected PR is already merged and terminal state is recorded");
    expect(alreadyMergedOutput).not.toContain("move the issue to Merging");
    expect(alreadyMergedOutput).not.toContain("missing terminal workspace warning");
  });
});

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolvePromise();
    });
  });
}
