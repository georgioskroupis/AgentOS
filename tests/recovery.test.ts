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
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;

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
    const recoveredRunId = "run_recovered";
    const stalePrUrl = "https://github.com/o/r/pull/1";
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
      runId: recoveredRunId,
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
      lastRunId: "run_failed",
      lifecycleStatus: "implementation_failure",
      lastError: "codex_stall_timeout",
      stopReason: "codex_stall_timeout",
      retryAttempt: 2,
      nextRetryAt: "2026-05-17T01:00:00.000Z",
      workspacePath: workspace,
      prs: [{ url: stalePrUrl, discoveredAt: "2026-05-17T00:00:00.000Z", source: "handoff", role: "primary" }],
      prUrl: stalePrUrl,
      mergeTargetUrl: stalePrUrl,
      mergeTargetRole: "primary",
      reviewTargetUrls: [stalePrUrl],
      updatedAt: "2026-05-17T00:00:00.000Z"
    });
    const runtime = new RuntimeStateStore(repo);
    await runtime.upsertActiveRun({
      issueId: "linear-issue-id",
      identifier: issue.identifier,
      issue: { ...issue, id: "linear-issue-id" },
      attempt: 1,
      runId: "run_stale_active",
      startedAt: "2026-05-17T00:00:00.000Z",
      lastEventAt: "2026-05-17T00:10:00.000Z",
      phase: "implementing",
      workspacePath: workspace,
      workspaceKey: issue.identifier
    });
    await runtime.upsertRetry({
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
    await runtime.upsertRetry({
      issueId: "linear-issue-id",
      identifier: issue.identifier,
      issue: { ...issue, id: "linear-issue-id" },
      attempt: 3,
      dueAt: "2026-05-17T01:30:00.000Z",
      error: "codex_stall_timeout",
      scheduledAt: "2026-05-17T00:30:00.000Z",
      workspacePath: workspace,
      workspaceKey: issue.identifier
    });

    const result = await recordOperatorRecovery({
      repoRoot: repo,
      issueIdentifier: issue.identifier,
      runId: recoveredRunId,
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
      lastRunId: recoveredRunId,
      headSha,
      validation: {
        status: "passed",
        finalStatus: "passed",
        failedHistoricalAttempts: [{ name: "npm run agent-check", exitCode: 1, startedAt: now, finishedAt: now }]
      },
      operatorRecovery: {
        runId: recoveredRunId,
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
    expect(state?.prs).toBeUndefined();
    expect(state?.prUrl).toBeUndefined();
    expect(state?.mergeTargetUrl).toBeUndefined();
    expect(state?.mergeTargetRole).toBeUndefined();
    expect(state?.reviewTargetUrls).toBeUndefined();
    const runtimeState = await new RuntimeStateStore(repo).read();
    expect(runtimeState.activeRuns).toEqual([]);
    expect(runtimeState.claimedIssues).toEqual([]);
    expect(runtimeState.retryQueue).toEqual([]);

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

    await recordOperatorRecovery({
      repoRoot: repo,
      issueIdentifier: issue.identifier,
      runId: recoveredRunId,
      now: "2026-05-17T03:00:00.000Z"
    });
    const rerecordedState = await new IssueStateStore(repo).read(issue.identifier);
    expect(rerecordedState?.operatorRecovery?.previousFailure).toMatchObject({
      lastError: "codex_stall_timeout",
      retryAttempt: 2,
      lifecycleStatus: "implementation_failure"
    });
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("replaces stale PR output with recovered handoff PR metadata", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-recovery-prs-"));
    const { workspace, headSha } = await createWorkspace(repo, { pushBranch: true });
    const now = new Date().toISOString();
    const stalePrUrl = "https://github.com/o/r/pull/1";
    const recoveredPrUrl = "https://github.com/o/r/pull/2";
    await mkdir(join(workspace, ".agent-os"), { recursive: true });
    await writeFile(
      join(workspace, ".agent-os", `handoff-${issue.identifier}.md`),
      [
        "AgentOS-Outcome: implemented",
        `Validation-JSON: .agent-os/validation/${issue.identifier}.json`,
        `Primary PR: ${recoveredPrUrl}`
      ].join("\n"),
      "utf8"
    );
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", `${issue.identifier}.json`), {
      schemaVersion: 1,
      issueIdentifier: issue.identifier,
      runId: "run_recovered_pr",
      repoHead: headSha,
      status: "passed",
      commands: [{ name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }]
    });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      lastRunId: "run_failed",
      workspacePath: workspace,
      prs: [{ url: stalePrUrl, discoveredAt: "2026-05-17T00:00:00.000Z", source: "handoff", role: "primary" }],
      prUrl: stalePrUrl,
      mergeTargetUrl: stalePrUrl,
      mergeTargetRole: "primary",
      reviewTargetUrls: [stalePrUrl],
      updatedAt: "2026-05-17T00:00:00.000Z"
    });

    const result = await recordOperatorRecovery({
      repoRoot: repo,
      issueIdentifier: issue.identifier,
      runId: "run_recovered_pr",
      now: "2026-05-17T02:00:00.000Z"
    });

    expect(result.state.prs?.map((pr) => pr.url)).toEqual([recoveredPrUrl]);
    expect(result.state.prUrl).toBe(recoveredPrUrl);
    expect(result.state.mergeTargetUrl).toBe(recoveredPrUrl);
    expect(result.state.mergeTargetRole).toBe("primary");
    expect(result.state.reviewTargetUrls).toEqual([recoveredPrUrl]);
    expect(result.state.lastRunId).toBe("run_recovered_pr");
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses recovered previous-run validation evidence without a matching reuse profile", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-recovery-reuse-profile-"));
    const { workspace, headSha } = await createWorkspace(repo, { pushBranch: true });
    const now = new Date().toISOString();
    await mkdir(join(workspace, ".agent-os"), { recursive: true });
    await writeFile(
      join(workspace, ".agent-os", `handoff-${issue.identifier}.md`),
      ["AgentOS-Outcome: implemented", `Validation-JSON: .agent-os/validation/${issue.identifier}.json`].join("\n"),
      "utf8"
    );
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", `${issue.identifier}.json`), {
      schemaVersion: 1,
      issueIdentifier: issue.identifier,
      runId: "run_previous",
      repoHead: headSha,
      status: "passed",
      commands: [{ name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }]
    });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "human-required",
      lastRunId: "run_failed",
      workspacePath: workspace,
      updatedAt: "2026-05-17T00:00:00.000Z"
    });

    await expect(
      recordOperatorRecovery({
        repoRoot: repo,
        issueIdentifier: issue.identifier,
        runId: "run_current",
        now: "2026-05-17T02:00:00.000Z"
      })
    ).rejects.toThrow(/validation reuse profile is missing/);
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("refuses partially satisfied handoffs as successful recovery evidence", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-recovery-partial-"));
    const { workspace } = await createWorkspace(repo, { pushBranch: true });
    await mkdir(join(workspace, ".agent-os"), { recursive: true });
    await writeFile(
      join(workspace, ".agent-os", `handoff-${issue.identifier}.md`),
      ["AgentOS-Outcome: partially-satisfied", `Validation-JSON: .agent-os/validation/${issue.identifier}.json`].join("\n"),
      "utf8"
    );

    await expect(recordOperatorRecovery({ repoRoot: repo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /partially-satisfied without an approve-as-is human decision[\s\S]*Next safe action: finish/
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);

  it("records approve-as-is partially satisfied handoffs with passing validation and PR metadata", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-recovery-partial-approved-"));
    const { workspace, headSha } = await createWorkspace(repo, { pushBranch: true });
    const now = new Date().toISOString();
    const prUrl = "https://github.com/o/r/pull/42";
    await mkdir(join(workspace, ".agent-os"), { recursive: true });
    await writeFile(
      join(workspace, ".agent-os", `handoff-${issue.identifier}.md`),
      [
        "AgentOS-Outcome: partially-satisfied",
        "AgentOS-Human-Decision: approve-as-is",
        `Validation-JSON: .agent-os/validation/${issue.identifier}.json`,
        `Primary PR: ${prUrl}`,
        "App-Proof: .agent-os/proof/manual-review.md"
      ].join("\n"),
      "utf8"
    );
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", `${issue.identifier}.json`), {
      schemaVersion: 1,
      issueIdentifier: issue.identifier,
      runId: "run_partial_approved",
      repoHead: headSha,
      status: "passed",
      commands: [{ name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }]
    });
    await new IssueStateStore(repo).write({
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "canceled",
      lastRunId: "run_stale_canceled",
      workspacePath: workspace,
      updatedAt: "2026-05-17T00:00:00.000Z"
    });

    const result = await recordOperatorRecovery({
      repoRoot: repo,
      issueIdentifier: issue.identifier,
      now: "2026-05-17T02:00:00.000Z"
    });

    expect(result.state).toMatchObject({
      phase: "completed",
      outcome: "partially_satisfied",
      lastRunId: "run_partial_approved",
      prUrl,
      mergeTargetUrl: prUrl,
      mergeTargetRole: "primary",
      reviewTargetUrls: [prUrl],
      validation: { status: "passed", runId: "run_partial_approved" },
      appProof: { artifacts: [{ label: "app-proof", value: ".agent-os/proof/manual-review.md", source: "handoff" }] },
      lastHumanDecision: { type: "approve_as_is", source: "handoff" }
    });
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

    const cleanNoUpstreamRepo = await mkdtemp(join(tmpdir(), "agent-os-recovery-no-upstream-base-"));
    await createWorkspace(cleanNoUpstreamRepo, { pushBranch: false, commitChange: false });
    await expect(recordOperatorRecovery({ repoRoot: cleanNoUpstreamRepo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /branch agent\/AG-1 has no upstream[\s\S]*Next safe action: push agent\/AG-1/
    );

    const aheadRepo = await mkdtemp(join(tmpdir(), "agent-os-recovery-ahead-"));
    const ahead = await createWorkspace(aheadRepo, { pushBranch: true });
    await commitReadme(ahead.workspace, "local ahead work\n", "local ahead");
    await expect(recordOperatorRecovery({ repoRoot: aheadRepo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /branch agent\/AG-1 is 1 commit\(s\) ahead of upstream[\s\S]*Next safe action: push/
    );

    const behindRepo = await mkdtemp(join(tmpdir(), "agent-os-recovery-behind-"));
    const behind = await createWorkspace(behindRepo, { pushBranch: true });
    await advanceUpstreamBranch(behindRepo, "upstream work\n");
    await run("git", ["fetch", "origin"], behind.workspace);
    await expect(recordOperatorRecovery({ repoRoot: behindRepo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /branch agent\/AG-1 is 1 commit\(s\) behind upstream[\s\S]*Next safe action: pull or reset/
    );

    const divergedRepo = await mkdtemp(join(tmpdir(), "agent-os-recovery-diverged-"));
    const diverged = await createWorkspace(divergedRepo, { pushBranch: true });
    await advanceUpstreamBranch(divergedRepo, "upstream diverged work\n");
    await run("git", ["fetch", "origin"], diverged.workspace);
    await commitReadme(diverged.workspace, "local diverged work\n", "local diverged");
    await expect(recordOperatorRecovery({ repoRoot: divergedRepo, issueIdentifier: issue.identifier })).rejects.toThrow(
      /branch agent\/AG-1 has diverged from upstream[\s\S]*Next safe action: reconcile/
    );
  }, INTEGRATION_TEST_TIMEOUT_MS);
});

async function createWorkspace(repo: string, options: { pushBranch: boolean; commitChange?: boolean }): Promise<{ workspace: string; headSha: string }> {
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
  if (options.commitChange !== false) await commitReadme(workspace, "recovered work\n", "recover issue");
  if (options.pushBranch) await run("git", ["push", "-u", "origin", `agent/${issue.identifier}`], workspace);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
  return { workspace, headSha: stdout.trim() };
}

async function commitReadme(workspace: string, content: string, message: string): Promise<void> {
  await writeFile(join(workspace, "README.md"), content, "utf8");
  await run("git", ["add", "README.md"], workspace);
  await run("git", ["commit", "-m", message], workspace);
}

async function advanceUpstreamBranch(repo: string, content: string): Promise<void> {
  const clone = join(repo, `upstream-${content.replace(/[^a-z]/g, "-")}`);
  await run("git", ["clone", join(repo, "remote.git"), clone], repo);
  await run("git", ["config", "user.email", "agentos@example.test"], clone);
  await run("git", ["config", "user.name", "AgentOS Test"], clone);
  await run("git", ["checkout", "-B", `agent/${issue.identifier}`, `origin/agent/${issue.identifier}`], clone);
  await commitReadme(clone, content, "advance upstream");
  await run("git", ["push", "origin", `agent/${issue.identifier}`], clone);
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd });
}
