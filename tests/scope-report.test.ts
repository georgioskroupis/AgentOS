import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { IssueStateStore } from "../src/issue-state.js";
import { RunArtifactStore } from "../src/runs.js";
import { buildPreDispatchScopeReport } from "../src/scope-report.js";
import type { Issue, IssueState } from "../src/types.js";

const execFileAsync = promisify(execFile);

describe("pre-dispatch scope report", () => {
  it("classifies already-satisfied work from prior handoff and validation evidence", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-satisfied-"));
    const issue = fakeIssue({
      identifier: "AG-1",
      title: "No-op accepted",
      description: "Acceptance criteria are already present in the current implementation."
    });
    const workspacePath = join(".agent-os", "workspaces", "AG-1");
    await mkdir(join(repo, workspacePath, ".agent-os", "validation"), { recursive: true });
    await writeFile(join(repo, workspacePath, ".agent-os", "handoff-AG-1.md"), "AgentOS-Outcome: already-satisfied\n", "utf8");
    const state = await writeIssueState(repo, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      outcome: "already_satisfied",
      phase: "completed",
      workspacePath,
      validation: {
        status: "passed",
        finalStatus: "passed",
        checkedAt: "2026-05-08T00:00:00.000Z",
        acceptedCommands: [
          {
            name: "npm run agent-check",
            exitCode: 0,
            startedAt: "2026-05-08T00:00:00.000Z",
            finishedAt: "2026-05-08T00:01:00.000Z"
          }
        ]
      }
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue, state, now: "2026-05-08T00:02:00.000Z" });

    expect(report.implementationStatus).toBe("already_satisfied");
    expect(report.docsImpact).toBe("none");
    expect(report.testsImpact).toBe("none");
    expect(report.prLikelihood).toBe("no_pr_likely");
    expect(report.evidence.validation).toMatchObject({ present: true, status: "passed", latestCommand: "npm run agent-check" });
    expect(report.evidence.handoff).toMatchObject({ present: true, workspacePath: join(".agent-os", "workspaces", "AG-1", ".agent-os", "handoff-AG-1.md") });
  });

  it("classifies dirty no-upstream workspace evidence as recoverable partial work", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-partial-"));
    const issue = fakeIssue({
      identifier: "AG-2",
      title: "Resume stalled validation work",
      description: "Previous work may have stopped while validation was running."
    });
    const workspacePath = join(".agent-os", "workspaces", "AG-2");
    const absoluteWorkspace = join(repo, workspacePath);
    await mkdir(absoluteWorkspace, { recursive: true });
    await initGitRepo(absoluteWorkspace);
    await writeFile(join(absoluteWorkspace, "dirty.txt"), "uncommitted\n", "utf8");

    const runStore = new RunArtifactStore(repo);
    const run = await runStore.startRun({ issue, attempt: 0 });
    await runStore.writeEvent(run.runId, {
      type: "item/started",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      timestamp: "2026-05-08T00:00:00.000Z",
      payload: {
        params: {
          item: {
            type: "commandExecution",
            command: "npm run agent-check"
          }
        }
      }
    });
    await runStore.completeRun(run.runId, {
      status: "stalled",
      error: "codex_stall_timeout",
      inputTokens: 70_000,
      outputTokens: 40_000,
      totalTokens: 110_000
    });
    const state = await writeIssueState(repo, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "streaming-turn",
      lastRunId: run.runId,
      lastError: "codex_stall_timeout",
      workspacePath,
      prs: [
        {
          url: "https://github.com/o/r/pull/22",
          role: "primary",
          source: "handoff",
          discoveredAt: "2026-05-08T00:00:00.000Z"
        }
      ],
      validation: {
        status: "missing",
        checkedAt: "2026-05-08T00:00:00.000Z"
      }
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue, state });

    expect(report.implementationStatus).toBe("partially_satisfied");
    expect(report.implementationStatusReasons.join("\n")).toContain("workspace has uncommitted changes");
    expect(report.evidence.workspace).toMatchObject({ present: true, dirty: true, upstreamMissing: true, recoverable: true });
    expect(report.evidence.pullRequests).toMatchObject({ present: true, count: 1 });
    expect(report.evidence.lastRun).toMatchObject({
      status: "stalled",
      stopReason: "codex_stall_timeout",
      tokenTotal: 110_000,
      quietValidationStop: true
    });
    expect(report.evidence.lastRun.eventCount).toBeGreaterThan(0);
    expect(report.evidence.lastRun.latestCommandActivity).toMatchObject({
      command: "npm run agent-check",
      outputSeen: false,
      validationCommand: true
    });
    expect(report.dispatchAdvice.notes.join("\n")).toContain("dirty workspace with no upstream is recoverable partial work");
  });

  it("does not classify a clean no-upstream branch at origin/main as recoverable partial work", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-clean-no-upstream-"));
    const issue = fakeIssue({
      identifier: "AG-7",
      title: "Retry clean initialization timeout",
      description: "Previous app-server initialization timed out before implementation started."
    });
    const workspacePath = join(".agent-os", "workspaces", "AG-7");
    const absoluteWorkspace = join(repo, workspacePath);
    await mkdir(absoluteWorkspace, { recursive: true });
    await initGitRepoWithOriginMain(absoluteWorkspace);
    await run("git", ["checkout", "-b", "agent/AG-7"], absoluteWorkspace);
    const state = await writeIssueState(repo, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "needs-input",
      lastError: "codex_read_timeout: initialize",
      workspacePath
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue, state });

    expect(report.evidence.workspace).toMatchObject({
      present: true,
      upstreamMissing: true,
      dirty: false,
      aheadCount: 0,
      recoverable: false,
      reasons: []
    });
    expect(report.implementationStatus).toBe("missing");
    expect(report.dispatchAdvice.shouldBlock).toBe(false);
  });

  it("classifies narrow missing work as small", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-small-"));
    const issue = fakeIssue({
      identifier: "AG-3",
      title: "Add doctor command success text",
      description: "Acceptance criteria:\n- Print a success line for doctor."
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue });

    expect(report.implementationStatus).toBe("missing");
    expect(report.scopeSize).toBe("small");
    expect(report.likelyLarge).toBe(false);
    expect(report.prLikelihood).toBe("pr_likely");
    expect(report.dispatchAdvice.shouldBlock).toBe(false);
  });

  it("classifies repo-root handoff evidence as partial work", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-root-handoff-"));
    const issue = fakeIssue({
      identifier: "AG-6",
      title: "Resume existing handoff",
      description: "Acceptance criteria:\n- Reuse existing handoff evidence."
    });
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "handoff-AG-6.md"), "AgentOS-Outcome: implemented\n", "utf8");

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue });

    expect(report.implementationStatus).toBe("partially_satisfied");
    expect(report.evidence.handoff).toMatchObject({
      present: true,
      repoPath: join(".agent-os", "handoff-AG-6.md"),
      workspacePath: null,
      runArtifactPath: null
    });
  });

  it("surfaces broad missing work as likely large and recommends planning before dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-large-"));
    const issue = fakeIssue({
      identifier: "AG-4",
      title: "Add orchestration report across Linear, GitHub, runtime, validation, docs, and workspaces",
      description: [
        "Roadmap item for broad orchestrator observability.",
        "- Audit Linear lifecycle state.",
        "- Inspect GitHub pull request state.",
        "- Read runtime state and run events.",
        "- Include validation and handoff evidence.",
        "- Estimate docs and tests impact.",
        "- Surface workspace recovery and branch state.",
        "- Keep dispatch behavior unchanged."
      ].join("\n")
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue });

    expect(report.implementationStatus).toBe("missing");
    expect(report.scopeSize).toBe("large");
    expect(report.likelyLarge).toBe(true);
    expect(report.reviewRisk).toBe("high");
    expect(report.dispatchAdvice).toMatchObject({
      shouldBlock: true,
      reason: "likely-large scope needs planning or decomposition before implementation dispatch"
    });
    expect(report.scopeScoring.score).toBeGreaterThanOrEqual(5);
    expect(report.scopeScoring).toMatchObject({
      largeThreshold: 5,
      textSource: "issue_full_text",
      reasons: expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining("likely subsystem") }),
        { score: 2, reason: "has 7 acceptance/detail bullet(s)" },
        { score: 2, reason: "contains broad orchestration or roadmap language" }
      ])
    });
    expect(report.dispatchAdvice.notes.join("\n")).toContain("likely-large scope should be planned or decomposed before implementation");
  });

  it("uses trusted bounded Active-Scope to resolve a prior planning pause without scoring background text", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-reentry-resolved-"));
    const issue = fakeIssue({
      identifier: "AG-8",
      title: "MVP roadmap orchestration work",
      description: [
        "Bootstrap a compact slice.",
        "",
        "Background:",
        "- Roadmap orchestration across Linear, GitHub, runtime, validation, docs, and workspaces.",
        "- Migrate every workflow and architecture guardrail.",
        "- Decompose dependencies across all projects.",
        "- Include broad follow-up tracking.",
        "- Audit registry daemon behavior.",
        "- Update every runbook.",
        "",
        "History:",
        "- Prior attempts scored the full roadmap as active scope."
      ].join("\n")
    });
    const state = await writeIssueState(repo, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "needs-input",
      lifecycleStatus: "planning_required",
      stopReason: "likely-large scope needs planning or decomposition before implementation dispatch",
      humanDecisions: [trustedFixDecision(activeScopeDecisionBody(), "2026-05-08T00:01:00.000Z")],
      lastHumanDecision: trustedFixDecision(activeScopeDecisionBody(), "2026-05-08T00:01:00.000Z")
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue, state });

    expect(report.evidence.planningReentry).toMatchObject({
      status: "satisfied",
      activeScopePresent: true,
      activeScopeBounded: true
    });
    expect(report.scopeScoring.textSource).toBe("trusted_active_scope");
    expect(report.scopeScoring.ignoredSections).toEqual(expect.arrayContaining(["Background", "History", "issue text superseded by trusted Active-Scope"]));
    expect(report.scopeSize).not.toBe("large");
    expect(report.dispatchAdvice.shouldBlock).toBe(false);
  });

  it("keeps a prior planning pause blocked when trusted re-entry lacks active scope or decomposition evidence", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-reentry-unresolved-"));
    const issue = fakeIssue({
      identifier: "AG-9",
      title: "Small implementation after pause",
      description: "Acceptance criteria:\n- Add one focused status line."
    });
    const state = await writeIssueState(repo, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      phase: "needs-input",
      lifecycleStatus: "planning_required",
      stopReason: "likely-large scope needs planning or decomposition before implementation dispatch",
      humanDecisions: [trustedFixDecision("AgentOS-Human-Decision: fix-findings\nDecision-Summary: please proceed", "2026-05-08T00:01:00.000Z")],
      lastHumanDecision: trustedFixDecision("AgentOS-Human-Decision: fix-findings\nDecision-Summary: please proceed", "2026-05-08T00:01:00.000Z")
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue, state });

    expect(report.scopeSize).toBe("small");
    expect(report.evidence.planningReentry).toMatchObject({
      status: "missing",
      activeScopePresent: false,
      decompositionEvidencePresent: false
    });
    expect(report.dispatchAdvice).toMatchObject({
      shouldBlock: true,
      reason: "planning re-entry needs bounded active scope or linked decomposition evidence"
    });
  });

  it("ignores verbose background, rationale, history, and split follow-up sections when estimating active scope", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-background-filter-"));
    const issue = fakeIssue({
      identifier: "AG-10",
      title: "Add focused inspect output",
      description: [
        "Acceptance criteria:",
        "- Show the latest scope score in inspect.",
        "",
        "Background:",
        "- Roadmap orchestration across Linear, GitHub, runtime, validation, docs, and workspaces.",
        "- Migrate every workflow and architecture guardrail.",
        "",
        "Rationale:",
        "- This context mentions broad dependencies and all projects.",
        "",
        "History:",
        "- Prior runs timed out across the orchestrator.",
        "",
        "Split follow-up:",
        "- Build the registry dependency DAG.",
        "- Redesign high-throughput merge behavior."
      ].join("\n")
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue });

    expect(report.scopeScoring.textSource).toBe("issue_active_sections");
    expect(report.scopeScoring.ignoredSections).toEqual(expect.arrayContaining(["Background", "Rationale", "History", "Split follow-up"]));
    expect(report.scopeSize).toBe("small");
    expect(report.dispatchAdvice.shouldBlock).toBe(false);
  });

  it("does not treat an agent-check validation bullet as broad scope by itself", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-agent-check-"));
    const issue = fakeIssue({
      identifier: "AG-11",
      title: "Require standard validation",
      description: "Done when:\n- npm run agent-check passes."
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue });

    expect(report.scopeScoring.textSource).toBe("issue_active_sections");
    expect(report.scopeScoring.reasons).toEqual([]);
    expect(report.scopeSize).toBe("small");
    expect(report.dispatchAdvice.shouldBlock).toBe(false);
  });

  it("classifies vague candidates as unclear", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-scope-unclear-"));
    const issue = fakeIssue({
      identifier: "AG-5",
      title: "Investigate weird behavior",
      description: null
    });

    const report = await buildPreDispatchScopeReport({ repoRoot: repo, issue });

    expect(report.implementationStatus).toBe("unclear");
    expect(report.scopeSize).toBe("unclear");
    expect(report.prLikelihood).toBe("unclear");
    expect(report.implementationStatusReasons.join("\n")).toContain("lacks enough concrete acceptance detail");
  });
});

function fakeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.identifier ? `issue-${overrides.identifier}` : "issue-AG-1",
    identifier: "AG-1",
    title: "Test issue",
    description: null,
    priority: 1,
    state: "Ready",
    branch_name: null,
    url: null,
    assignee: null,
    labels: [],
    blocked_by: [],
    created_at: "2026-05-08T00:00:00.000Z",
    updated_at: "2026-05-08T00:00:00.000Z",
    ...overrides
  };
}

async function writeIssueState(repo: string, patch: Omit<Partial<IssueState>, "schemaVersion" | "updatedAt"> & Pick<IssueState, "issueId" | "issueIdentifier">): Promise<IssueState> {
  const state: IssueState = {
    schemaVersion: 1,
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...patch
  };
  await new IssueStateStore(repo).write(state);
  return state;
}

async function initGitRepo(cwd: string): Promise<void> {
  await run("git", ["init"], cwd);
  await run("git", ["config", "user.email", "agentos@example.com"], cwd);
  await run("git", ["config", "user.name", "AgentOS"], cwd);
  await writeFile(join(cwd, "README.md"), "initial\n", "utf8");
  await run("git", ["add", "README.md"], cwd);
  await run("git", ["commit", "-m", "Initial commit"], cwd);
}

async function initGitRepoWithOriginMain(cwd: string): Promise<void> {
  const remote = `${cwd}-remote.git`;
  await run("git", ["init", "--bare", remote], cwd);
  await run("git", ["init", "-b", "main"], cwd);
  await run("git", ["config", "user.email", "agentos@example.com"], cwd);
  await run("git", ["config", "user.name", "AgentOS"], cwd);
  await writeFile(join(cwd, "README.md"), "initial\n", "utf8");
  await run("git", ["add", "README.md"], cwd);
  await run("git", ["commit", "-m", "Initial commit"], cwd);
  await run("git", ["remote", "add", "origin", remote], cwd);
  await run("git", ["push", "-u", "origin", "main"], cwd);
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd });
}

function activeScopeDecisionBody(): string {
  return [
    "AgentOS-Human-Decision: fix-findings",
    "Decision-Summary: continue with a compact active implementation slice.",
    "",
    "Active-Scope:",
    "Make planning re-entry artifacts machine-readable.",
    "",
    "Done when:",
    "* Pre-dispatch scope reports expose exact scoring reasons.",
    "* Trusted planning re-entry evidence can clear a prior planning pause.",
    "* Scope scoring ignores background text.",
    "* Broad unsplit work still pauses.",
    "* npm run agent-check passes.",
    "",
    "Out of scope:",
    "Dependency DAG execution and high-throughput merge behavior."
  ].join("\n");
}

function trustedFixDecision(body: string, decidedAt: string) {
  return {
    type: "fix_findings" as const,
    decidedAt,
    source: "linear-comment" as const,
    actor: "Supervisor",
    actorId: "user-supervisor",
    actorEmail: "supervisor@example.com",
    trusted: true,
    commentId: `comment-${decidedAt}`,
    body
  };
}
