import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { IssueStateStore } from "../src/issue-state.js";
import { recordOperatorRecovery } from "../src/recovery.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { getStatus, inspectIssue } from "../src/status.js";
import type { Issue } from "../src/types.js";
import { writeValidationEvidence } from "../src/validation.js";

const execFileAsync = promisify(execFile);
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Recovery issue",
  description: null,
  priority: 1,
  state: "Todo",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: "2026-05-17T00:00:00.000Z",
  updated_at: "2026-05-17T00:00:00.000Z"
};

describe("operator recovery", () => {
  it("records clean recovered branch, handoff, validation, and proof while clearing stale failure state", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-recovery-record-"));
    const { workspace, headSha } = await createWorkspace(repo, { pushBranch: true });
    const now = new Date().toISOString();
    await mkdir(join(workspace, ".agent-os"), { recursive: true });
    await writeFile(
      join(workspace, ".agent-os", `handoff-${issue.identifier}.md`),
      [
        "AgentOS-Outcome: implemented",
        `Validation-JSON: .agent-os/validation/${issue.identifier}.json`,
        "App-Proof: .agent-os/proof/latest-proof.md"
      ].join("\n"),
      "utf8"
    );
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", `${issue.identifier}.json`), {
      schemaVersion: 1,
      issueIdentifier: issue.identifier,
      repoHead: headSha,
      status: "passed",
      commands: [
        { name: "npm run agent-check", exitCode: 1, startedAt: now, finishedAt: now },
        { name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }
      ]
    });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "needs-input",
      lifecycleStatus: "implementation_failure",
      lastError: "codex_stall_timeout",
      stopReason: "codex_stall_timeout",
      retryAttempt: 2,
      nextRetryAt: "2026-05-17T01:00:00.000Z",
      workspacePath: workspace,
      updatedAt: "2026-05-17T00:00:00.000Z"
    });
    await new RuntimeStateStore(repo).upsertRetry({
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt: 2,
      dueAt: "2026-05-17T01:00:00.000Z",
      error: "codex_stall_timeout",
      scheduledAt: "2026-05-17T00:00:00.000Z",
      workspacePath: workspace,
      workspaceKey: issue.identifier
    });

    const result = await recordOperatorRecovery({
      repoRoot: repo,
      issueIdentifier: issue.identifier,
      now: "2026-05-17T02:00:00.000Z"
    });

    expect(result).toMatchObject({
      issueIdentifier: issue.identifier,
      branch: `agent/${issue.identifier}`,
      headSha,
      proofArtifacts: [{ label: "app-proof", value: ".agent-os/proof/latest-proof.md", source: "handoff" }]
    });
    const state = await new IssueStateStore(repo).read(issue.identifier);
    expect(state).toMatchObject({
      phase: "completed",
      outcome: "implemented",
      headSha,
      validation: {
        status: "passed",
        finalStatus: "passed",
        failedHistoricalAttempts: [{ name: "npm run agent-check", exitCode: 1, startedAt: now, finishedAt: now }]
      },
      operatorRecovery: {
        branch: `agent/${issue.identifier}`,
        headSha,
        handoffPath: join(".agent-os", "workspaces", issue.identifier, ".agent-os", `handoff-${issue.identifier}.md`),
        previousFailure: {
          lastError: "codex_stall_timeout",
          retryAttempt: 2,
          lifecycleStatus: "implementation_failure"
        }
      }
    });
    expect(state?.lastError).toBeUndefined();
    expect(state?.stopReason).toBeUndefined();
    expect(state?.retryAttempt).toBeUndefined();
    expect(state?.nextRetryAt).toBeUndefined();
    expect(state?.lifecycleStatus).toBeUndefined();
    expect((await new RuntimeStateStore(repo).read()).retryQueue).toEqual([]);

    const status = await getStatus(repo);
    expect(status).toContain("AG-1: completed locally");
    expect(status).not.toContain("recoverable partial work");
    expect(status).not.toContain("retrying after codex_stall_timeout");

    const inspect = await inspectIssue(repo, issue.identifier);
    expect(inspect).toContain("Operator recovery: 2026-05-17T02:00:00.000Z");
    expect(inspect).toContain(`- Branch: agent/${issue.identifier}`);
    expect(inspect).toContain("Failed historical attempts:");
    expect(inspect).not.toContain("Last error: codex_stall_timeout");
    expect(inspect).not.toContain("Stop reason: codex_stall_timeout");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses dirty, missing, and ambiguous worktree evidence with next actions", async () => {
    const missingRepo = await mkdtemp(join(tmpdir(), "agent-os-recovery-missing-"));
    await expect(recordOperatorRecovery({ repoRoot: missingRepo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /workspace evidence is missing[\s\S]*Next safe action: restore/
    );

    const dirtyRepo = await mkdtemp(join(tmpdir(), "agent-os-recovery-dirty-"));
    const dirty = await createWorkspace(dirtyRepo, { pushBranch: true });
    await writeFile(join(dirty.workspace, "README.md"), "dirty recovered work\n", "utf8");
    await expect(recordOperatorRecovery({ repoRoot: dirtyRepo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /worktree has uncommitted changes[\s\S]*Next safe action: commit or stash/
    );

    const ambiguousRepo = await mkdtemp(join(tmpdir(), "agent-os-recovery-ambiguous-"));
    await createWorkspace(ambiguousRepo, { pushBranch: false });
    await expect(recordOperatorRecovery({ repoRoot: ambiguousRepo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /branch agent\/AG-1 has no upstream[\s\S]*Next safe action: push agent\/AG-1/
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

async function createWorkspace(repo: string, options: { pushBranch: boolean }): Promise<{ workspace: string; headSha: string }> {
  const workspace = join(repo, ".agent-os", "workspaces", issue.identifier);
  const remote = join(repo, "remote.git");
  await mkdir(workspace, { recursive: true });
  await run("git", ["init", "--bare", remote], repo);
  await run("git", ["init", "-b", "main"], workspace);
  await run("git", ["config", "user.email", "agentos@example.test"], workspace);
  await run("git", ["config", "user.name", "AgentOS Test"], workspace);
  await writeFile(join(workspace, ".gitignore"), ".agent-os/\n", "utf8");
  await writeFile(join(workspace, "README.md"), "initial\n", "utf8");
  await run("git", ["add", ".gitignore", "README.md"], workspace);
  await run("git", ["commit", "-m", "initial"], workspace);
  await run("git", ["remote", "add", "origin", remote], workspace);
  await run("git", ["push", "-u", "origin", "main"], workspace);
  await run("git", ["checkout", "-b", `agent/${issue.identifier}`], workspace);
  await writeFile(join(workspace, "README.md"), "recovered work\n", "utf8");
  await run("git", ["add", "README.md"], workspace);
  await run("git", ["commit", "-m", "recover issue"], workspace);
  if (options.pushBranch) await run("git", ["push", "-u", "origin", `agent/${issue.identifier}`], workspace);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
  return { workspace, headSha: stdout.trim() };
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd });
}
