import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { daemonLaunchCommand, inspectDaemonHealth } from "./daemon-health.js";
import { IssueStateStore, isAuthoritativeHumanDecision, latestAuthoritativeHumanDecision, latestHumanDecision, normalizeIssueState, pullRequestUrls } from "./issue-state.js";
import { JsonlLogger } from "./logging.js";
import { loadRegistry, RegistryStateStore, resolveRegistryProjectPaths, type RegistryProjectSummary } from "./registry.js";
import { formatRecoveryDiagnostics, inspectWorkspaceRecovery, type WorkspaceRecoveryDiagnostics } from "./recovery.js";
import { formatReviewRunnerFailures } from "./review.js";
import { formatReviewBudgetState, formatSplitRecommendation, isReviewSplitRecommendationBlocking } from "./review-budget.js";
import { RuntimeStateStore, type RuntimeActiveRun, type RuntimeRetryEntry } from "./runtime-state.js";
import { daemonCredentialDetails, daemonRuntimeDetails, getDaemonStatus } from "./status-daemon.js";
import { branchUpdateDetails } from "./status-branch-update.js";
import { contextBudgetDetails, recentEventMessage, runtimeWarningDetails, runtimeWarningSummary, scopeReportDetails, scopeReportStatusSuffix } from "./status-diagnostics.js";
import { appendEvidenceStatus, validationDetails } from "./status-validation.js";
import { loadWorkflow, resolveServiceConfig } from "./workflow.js";
import type { IssueState, ValidationState } from "./types.js";

export async function getStatus(repo = process.cwd(), limit = 20): Promise<string> {
  const root = resolve(repo);
  const logger = new JsonlLogger(root);
  const entries = await logger.tail(limit);
  const daemon = await inspectDaemonHealth(root);
  const runtime = await new RuntimeStateStore(root).read();
  const issues = await new IssueStateStore(root).list();
  const recoveries = await Promise.all(issues.map((issue) => inspectWorkspaceRecovery(root, issue).catch(() => null)));
  const issueLines = issues.map((issue, index) => `- ${issue.issueIdentifier}: ${issueStatusLine(issue, runtime, entries, recoveries[index] ?? null)}`);
  const lines = [
    `Daemon: ${daemon.status} - ${daemon.message}`,
    `Next safe action: ${daemon.nextSafeAction}`,
    ...daemonRuntimeDetails(runtime.daemon),
    "",
    "Issues:",
    issueLines.length ? issueLines.join("\n") : "No issues recorded.",
    "",
    "Recent events:",
    entries.length
      ? entries
          .map((entry) => {
            const issue = entry.issueIdentifier ? ` ${entry.issueIdentifier}` : "";
            const message = entry.message ? ` - ${recentEventMessage(entry)}` : "";
            return `${entry.timestamp} ${entry.type}${issue}${message}`;
          })
          .join("\n")
      : "No AgentOS run events recorded."
  ];
  return lines.join("\n");
}

export async function getRegistryStatus(registryPath = "agent-os.yml", limit = 20): Promise<string> {
  const registry = await loadRegistry(registryPath);
  const registryState = await new RegistryStateStore(registryPath).read();
  const globalConcurrency = registryState.projects.length > 0 ? registryState.globalConcurrency : registry.defaults?.maxConcurrency ?? registryState.globalConcurrency;
  const summaryByProject = new Map(registryState.projects.map((project) => [project.name, project]));
  const lines = [
    `Registry: ${resolve(registryPath)}`,
    `Global concurrency: ${globalConcurrency}`,
    `Projects: ${registry.projects.length}`
  ];

  for (const project of registry.projects) {
    const paths = resolveRegistryProjectPaths(project, registryPath);
    const summary = summaryByProject.get(project.name);
    const runtime = await new RuntimeStateStore(paths.repoRoot).read();
    const issues = await new IssueStateStore(paths.repoRoot).list();
    const logs = await new JsonlLogger(paths.repoRoot).tail(limit);
    const configLine = await projectConfigLine(paths.workflowPath).catch((error: Error) => `Config: unavailable (${error.message})`);
    const latest = summary ?? fallbackProjectSummary(project.name, paths.repoRoot, paths.workflowPath, runtime.activeRuns.length, runtime.retryQueue.length, runtime.claimedIssues.length, project.maxConcurrency ?? 1);
    lines.push(
      "",
      `- ${project.name}: ${latest.status}`,
      `  Repo: ${paths.repoRoot}`,
      `  Workflow: ${paths.workflowRelativePath}`,
      `  Concurrency: active ${runtime.activeRuns.length}/${latest.maxConcurrency}; claimed ${runtime.claimedIssues.length}; retrying ${runtime.retryQueue.length}`,
      `  ${configLine}`
    );
    if (latest.dispatched != null || latest.candidates != null) {
      lines.push(`  Last pass: dispatched ${latest.dispatched ?? 0}${latest.candidates != null ? ` of ${latest.candidates} candidate(s)` : ""}`);
    }
    if (latest.lastSuccessfulTrackerReadAt) lines.push(`  Last tracker read: ${latest.lastSuccessfulTrackerReadAt}`);
    if (latest.lastError) lines.push(`  Error: ${latest.errorCategory ?? "orchestrator"} - ${latest.lastError}`);
    if (runtime.daemon?.freshnessStatus) {
      lines.push(`  Daemon: ${runtime.daemon.freshnessStatus}${runtime.daemon.freshnessMessage ? ` - ${runtime.daemon.freshnessMessage}` : ""}`);
    }
    if (runtime.daemon?.preflightStatus) {
      lines.push(`  Daemon preflight: ${runtime.daemon.preflightStatus}${runtime.daemon.preflightMessage ? ` - ${runtime.daemon.preflightMessage}` : ""}`);
      if (runtime.daemon.repoEnvStatus) lines.push(`  Repo env: ${runtime.daemon.repoEnvStatus}${runtime.daemon.repoEnvPath ? ` (${runtime.daemon.repoEnvPath})` : ""}`);
      lines.push(...daemonCredentialDetails(runtime.daemon).map((line) => `  ${line}`));
    }

    const recoveries = await Promise.all(issues.map((issue) => inspectWorkspaceRecovery(paths.repoRoot, issue).catch(() => null)));
    const issueLines = issues.map((issue, index) => `  - ${issue.issueIdentifier}: ${issueStatusLine(issue, runtime, logs, recoveries[index] ?? null)}`);
    lines.push(issueLines.length ? "  Issues:" : "  Issues: none recorded");
    lines.push(...issueLines);
  }

  return lines.join("\n");
}

export async function inspectIssue(repo = process.cwd(), identifier: string, limit = 30): Promise<string> {
  const root = resolve(repo);
  const statePath = join(root, ".agent-os", "state", "issues", `${safeFileName(identifier)}.json`);
  const logger = new JsonlLogger(root);
  const entries = (await logger.tail(500))
    .filter((entry) => entry.issueIdentifier?.toLowerCase() === identifier.toLowerCase())
    .slice(-limit);
  const state = (await exists(statePath)) ? normalizeIssueState(JSON.parse(await readText(statePath))) : null;
  const recovery = await inspectWorkspaceRecovery(root, state).catch(() => null);
  const runtime = await new RuntimeStateStore(root).read();
  const active = state ? findRuntimeActive(runtime.activeRuns, state) : null;
  const retry = state ? findRuntimeRetry(runtime.retryQueue, state) : null;
  const statusDiagnostics = state ? issueStatusDiagnostics(state, recovery, retry, active) : [];
  const prs = state?.prs ?? [];
  const reviewRoot = join(root, ".agent-os", "reviews", safeFileName(identifier));
  const reviewArtifacts = (await exists(reviewRoot)) ? await listReviewArtifacts(reviewRoot, state) : [];
  const lines = [
    `Issue: ${identifier}`,
    state ? `Phase: ${state.phase ?? "unknown"}` : "Phase: unknown",
    state?.lifecycleStatus ? `Lifecycle: ${state.lifecycleStatus}` : null,
    state?.terminalState ? `Terminal state: ${state.terminalState}${state.terminalReason ? ` (${state.terminalReason})` : ""}` : null,
    prs.length ? `PRs:\n${prs.map((pr) => `- ${pr.url}${pr.role ? ` (${pr.role})` : ""}`).join("\n")}` : "PRs: none recorded",
    reviewDetails(state),
    formatReviewBudgetState(state?.reviewBudget),
    formatSplitRecommendation(state?.splitRecommendation, { advisory: isSplitRecommendationAdvisory(state) }),
    state?.reviewRunnerFailures?.length ? `Review runner failures:\n${formatReviewRunnerFailures(state.reviewRunnerFailures)}` : "Review runner failures: none recorded",
    humanDecisionDetails(state),
    scopeReportDetails(state),
    ciRetryDetails(state),
    branchUpdateDetails(state),
    appProofDetails(state),
    operatorRecoveryDetails(state),
    shouldFormatRecoveryDiagnostics(state, recovery) ? formatRecoveryDiagnostics(recovery).join("\n") : null,
    state ? `Next safe action: ${statusDiagnostics[0]?.nextAction ?? nextSafeAction(state, recovery)}` : null,
    ...daemonRuntimeDetails(runtime.daemon),
    state?.mergeTargetUrl ? `Merge target: ${state.mergeTargetUrl}${state.mergeTargetRole ? ` (${state.mergeTargetRole})` : ""}` : null,
    state?.mergeCleanupWarnings?.length ? `Merge cleanup warnings:\n${state.mergeCleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : null,
    statusDiagnostics.length ? `Status warnings:\n${statusDiagnostics.map(formatIssueStatusDiagnostic).join("\n")}` : "Status warnings: none",
    runtimeWarningDetails(entries, identifier),
    contextBudgetDetails(state),
    validationDetails(state),
    state?.lastError ? `Last error: ${state.lastError}` : null,
    state?.stopReason ? `Stop reason: ${state.stopReason}` : null,
    state?.nextRetryAt ? `Next retry: ${state.nextRetryAt}` : null,
    reviewArtifacts.length ? `Review artifacts:\n${reviewArtifacts.join("\n")}` : "Review artifacts: none",
    "",
    "Recent events:",
    entries.length
      ? entries.map((entry) => `${entry.timestamp} ${entry.type}${entry.message ? ` - ${recentEventMessage(entry)}` : ""}`).join("\n")
      : "No recent events for this issue."
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

async function listReviewArtifacts(root: string, state: IssueState | null): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
    }
  }
  await walk(root);
  return Promise.all(out.sort().map(async (path) => `- ${path}${await reviewArtifactFreshness(path, state)}`));
}

async function reviewArtifactFreshness(path: string, state: IssueState | null): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(await readText(path)) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return " [unknown: artifact metadata unreadable]";
    parsed = raw as Record<string, unknown>;
  } catch {
    return " [unknown: artifact metadata unreadable]";
  }

  const labels: string[] = [];
  const stale: string[] = [];
  const unknown: string[] = [];
  if (typeof parsed.iteration === "number" && Number.isInteger(parsed.iteration) && state?.reviewIteration != null) {
    const label = parsed.iteration === state.reviewIteration ? `iteration ${parsed.iteration} current` : `iteration ${parsed.iteration} stale; expected ${state.reviewIteration}`;
    labels.push(label);
    if (parsed.iteration !== state.reviewIteration) stale.push(label);
  } else if (state?.reviewIteration != null) {
    stale.push(`iteration missing; expected ${state.reviewIteration}`);
  } else {
    unknown.push("iteration comparison unavailable");
  }
  if (typeof parsed.runId === "string" && state?.lastRunId) {
    const label = parsed.runId === state.lastRunId ? `run ${parsed.runId} current` : `run ${parsed.runId} stale; expected ${state.lastRunId}`;
    labels.push(label);
    if (parsed.runId !== state.lastRunId) stale.push(label);
  } else if (state?.lastRunId) {
    stale.push(`run missing; expected ${state.lastRunId}`);
  } else {
    unknown.push("run comparison unavailable");
  }
  if (typeof parsed.headSha === "string" && state?.headSha) {
    const label = sameSha(parsed.headSha, state.headSha) ? `head ${shortSha(parsed.headSha)} current` : `head ${shortSha(parsed.headSha)} stale; expected ${shortSha(state.headSha)}`;
    labels.push(label);
    if (!sameSha(parsed.headSha, state.headSha)) stale.push(label);
  } else if (state?.headSha) {
    stale.push(`head missing; expected ${shortSha(state.headSha)}`);
  } else {
    unknown.push("head comparison unavailable");
  }
  if (stale.length) return ` [stale, non-authoritative: ${[...stale, ...unknown].join("; ")}]`;
  if (unknown.length) return ` [unknown, non-authoritative: ${[...labels, ...unknown].join("; ")}]`;
  return ` [current: ${labels.join("; ")}]`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function humanDecisionDetails(state: IssueState | null): string | null {
  const decision = state?.lastHumanDecision ?? latestHumanDecision(state?.humanDecisions);
  if (!decision) return "Human decision: none recorded";
  const lines = [
    `Human decision: ${decision.type}`,
    `Decision source: ${decision.source}`,
    `Decision authority: ${isAuthoritativeHumanDecision(decision) ? "authoritative" : "context-only"}`,
    !isAuthoritativeHumanDecision(decision) ? "Decision authority next action: assign the issue to this actor, add the actor to lifecycle.trusted_decision_actors, or provide a new authoritative structured decision." : null,
    decision.actor ? `Decision actor: ${decision.actor}` : null,
    `Decision time: ${decision.decidedAt}`,
    decision.prHeadSha ? `Decision PR head SHA: ${decision.prHeadSha}` : null,
    decision.validationEvidence ? `Decision validation: ${decision.validationEvidence}` : null,
    decision.ciState ? `Decision CI: ${decision.ciState}` : null,
    decision.findings ? `Decision findings: ${decision.findings}` : null
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function appProofDetails(state: IssueState | null): string | null {
  if (!state?.appProof?.artifacts.length) return "App proof: none recorded";
  return [
    `App proof: ${state.appProof.updatedAt}`,
    ...state.appProof.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.value}`)
  ].join("\n");
}

function operatorRecoveryDetails(state: IssueState | null): string | null {
  const recovery = state?.operatorRecovery;
  if (!recovery) return null;
  return [
    `Operator recovery: ${recovery.recordedAt}`,
    `- Branch: ${recovery.branch}`,
    `- Head: ${shortSha(recovery.headSha)}`,
    `- Handoff: ${recovery.handoffPath}`,
    recovery.validationPath ? `- Validation: ${recovery.validationPath}` : null,
    recovery.proofArtifacts.length ? `- Proof: ${recovery.proofArtifacts.map((artifact) => `${artifact.label}=${artifact.value}`).join(", ")}` : "- Proof: none recorded",
    recovery.previousFailure?.lastError ? `- Previous failure: ${recovery.previousFailure.lastError}` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function reviewDetails(state: IssueState | null): string {
  if (!state?.reviewStatus) return "Review: none recorded";
  if (state.reviewStatus === "pending" && isAuthoritativeTerminalIssueState(state)) return "Review: none recorded";
  return `Review: ${state.reviewStatus}${state.reviewIteration ? ` iteration ${state.reviewIteration}` : ""}`;
}

async function projectConfigLine(workflowPath: string): Promise<string> {
  const config = resolveServiceConfig(await loadWorkflow(workflowPath));
  return `Config: trust=${config.trustMode}; lifecycle=${config.lifecycle.mode}; automation=${config.automation.profile}/${config.automation.repairPolicy}; workflowMax=${config.agent.maxConcurrentAgents}`;
}

function fallbackProjectSummary(name: string, repoRoot: string, workflowPath: string, activeRuns: number, retryQueue: number, claimedIssues: number, maxConcurrency: number): RegistryProjectSummary {
  return {
    name,
    repoRoot,
    workflowPath,
    status: "idle",
    checkedAt: new Date().toISOString(),
    activeRuns,
    retryQueue,
    claimedIssues,
    maxConcurrency
  };
}

function issueStatusLine(issue: IssueState, runtime: Awaited<ReturnType<RuntimeStateStore["read"]>>, logs: Awaited<ReturnType<JsonlLogger["tail"]>>, recovery: WorkspaceRecoveryDiagnostics | null): string {
  const runtimeActive = findRuntimeActive(runtime.activeRuns, issue);
  const retry = findRuntimeRetry(runtime.retryQueue, issue);
  const statusDiagnostics = issueStatusDiagnostics(issue, recovery, retry, runtimeActive);
  if (statusDiagnostics.length) return `status warning - ${statusDiagnostics[0].message}; next: ${statusDiagnostics[0].nextAction}`;
  const withEvidence = (line: string) => appendEvidenceStatus(issue, line);
  if (runtimeActive) return withEvidence(`running (${runtimeActive.phase ?? issue.phase ?? "active"})`);
  if (retry && (retry.errorCategory === "capacity-wait" || issue.errorCategory === "capacity-wait")) return withEvidence(`capacity wait until ${retry.dueAt}; next: wait for the Codex usage reset time before redispatch`);
  if (retry) return withEvidence(`retrying after ${retry.error ?? issue.lastError ?? "unknown error"}; next retry ${retry.dueAt}`);
  const latestRunnerFailure = latestReviewRunnerFailure(issue);
  if ((issue.reviewStatus === "human_required" || issue.phase === "human-required") && latestRunnerFailure) {
    return withEvidence(`waiting on Human Review - reviewer runner failure (${latestRunnerFailure.reviewer}: ${latestRunnerFailure.reason})`);
  }
  if (recovery?.recoverable) return withEvidence(`recoverable partial work - ${recovery.reasons.join("; ")}; next: ${recovery.nextSafeAction}`);
  const terminalStatus = cleanTerminalStatusLine(issue);
  if (terminalStatus) return withEvidence(terminalStatus);
  if (isReviewSplitRecommendationBlocking(issue)) return withEvidence(`split recommended - ${issue.splitRecommendation?.summary}`);
  if (isActiveCiRetryWait(issue)) return withEvidence(`waiting on flaky CI retry - ${latestCiRetryAttempt(issue)?.checkNames.join(", ") ?? "checks"}`);
  if (issue.ciRetry?.status === "exhausted") return withEvidence(`flaky CI retry exhausted - ${latestCiRetryAttempt(issue)?.attempt ?? 0}/${latestCiRetryAttempt(issue)?.maxAttempts ?? 0}`);
  if (issue.ciRetry?.status === "failed") return withEvidence(`flaky CI retry failed - ${latestCiRetryAttempt(issue)?.error ?? "rerun request failed"}`);
  const mergeWaiting = [...logs].reverse().find((entry) => entry.issueIdentifier === issue.issueIdentifier && entry.type === "merge_waiting");
  if (mergeWaiting) return withEvidence(`waiting on CI - ${mergeWaiting.message ?? "selected PR checks are not ready"}`);
  const mergeFailed = [...logs].reverse().find((entry) => entry.issueIdentifier === issue.issueIdentifier && entry.type === "merge_failed");
  if (mergeFailed && issue.phase !== "completed") return withEvidence(`tracker/local disagreement or merge review needed - ${mergeFailed.message ?? "merge failed"}`);
  if (isCommentReadDispatchStop(issue)) return withEvidence(`dispatch guardrail paused - ${nextSafeAction(issue, recovery)}`);
  if (issue.lifecycleStatus === "planning_required") {
    return withEvidence(`planning required - ${nextSafeAction(issue, recovery)}${scopeReportStatusSuffix(issue.scopeReport)}`);
  }
  if (hasApprovedPullRequest(issue) && issue.phase === "completed") return withEvidence("waiting on merge");
  if (issue.lifecycleStatus === "human_continuation" || issue.lifecycleStatus === "supervisor_continuation" || issue.lifecycleStatus === "externally_fixed") {
    return withEvidence(`${issue.lifecycleStatus} - ${nextSafeAction(issue, recovery)}`);
  }
  if (issue.reviewStatus === "pending" || issue.phase === "review") return withEvidence(`waiting on review (${issue.reviewStatus ?? "pending"})`);
  if (issue.reviewStatus === "human_required" || issue.phase === "human-required") {
    return withEvidence(`waiting on Human Review${issue.lastError ? ` - ${issue.lastError}` : ""}`);
  }
  if (issue.phase === "merge") return withEvidence("waiting on merge");
  if (issue.nextRetryAt && issue.errorCategory === "capacity-wait") return withEvidence(`capacity wait until ${issue.nextRetryAt}; next: wait for the Codex usage reset time before redispatch`);
  if (issue.nextRetryAt) return withEvidence(`retrying after ${issue.lastError ?? "unknown error"}; next retry ${issue.nextRetryAt}`);
  const warningNoise = runtimeWarningSummary(logs, issue.issueIdentifier);
  if (warningNoise) return withEvidence(`runtime warning noise - ${warningNoise.summary}; next: ${warningNoise.nextAction}`);
  if (issue.validation) {
    const validation = validationStatusPhrase(issue.validation);
    if (validation) return withEvidence(validation);
  }
  if (issue.phase === "completed") return withEvidence("completed locally");
  return withEvidence(`${issue.phase ?? "recorded"}${issue.lastError ? ` - ${issue.lastError}` : ""}`);
}

function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function nextSafeAction(issue: IssueState, recovery: WorkspaceRecoveryDiagnostics | null = null): string {
  if (recovery?.recoverable) return recovery.nextSafeAction;
  const terminalAction = cleanTerminalNextSafeAction(issue);
  if (terminalAction) return terminalAction;
  if (issue.contextBudget?.status === "exceeded") return "reduce prompt context by narrowing Active-Scope, pruning large artifacts, or splitting follow-up work before redispatch";
  if (issue.errorCategory === "capacity-wait" && issue.nextRetryAt) return `wait until ${issue.nextRetryAt}, then let AgentOS redispatch without incrementing the normal retry budget`;
  const decision = latestAuthoritativeHumanDecision([
    ...(issue.humanDecisions ?? []),
    ...(issue.lastHumanDecision ? [issue.lastHumanDecision] : [])
  ]);
  if (issue.lifecycleStatus === "planning_required" || /planning|decomposition|likely-large/i.test(issue.stopReason ?? "")) {
    if (issue.scopeReport?.planningReentry.status === "missing") return issue.scopeReport.dispatchAdvice.nextSafeAction;
    return "create or attach a planning/decomposition artifact, or split follow-up issues, before returning the issue to implementation";
  }
  if (isCommentReadDispatchStop(issue)) {
    return "restore Linear comment access, then rerun dispatch so latest structured decisions are reconciled before any implementation turn";
  }
  if (issue.lifecycleStatus === "externally_fixed" || decision?.type === "proceed_to_merge_after_supervisor_fix") {
    return "verify fresh validation and green CI, then move the issue to Merging; do not redispatch Codex unless a new fix-findings decision is recorded";
  }
  if (isReviewSplitRecommendationBlocking(issue)) {
    return "record a split-follow-up decision or create linked follow-up issue(s) before another broad review/fix iteration";
  }
  if (isActiveCiRetryWait(issue)) {
    return "wait for the GitHub Actions rerun to settle, refresh PR status, and continue review only on the selected head";
  }
  if (issue.ciRetry?.status === "exhausted" || issue.ciRetry?.status === "failed") {
    return "inspect the failed check and record a human decision before retrying, repairing, or accepting risk";
  }
  if (hasApprovedPullRequest(issue)) {
    return "mark the PR ready only after fresh validation and green CI, then move the issue to Merging for the shepherd";
  }
  if (decision?.type === "fix_findings") {
    return "redispatch from Todo/In Progress with recent Linear comments, PR feedback, and review context included in the next prompt";
  }
  if (decision?.type === "approve_as_is" || decision?.type === "accept_risk" || decision?.type === "split_follow_up") {
    return "keep Codex paused; move to Merging only when remaining risk is accepted and required validation/CI evidence is fresh";
  }
  if (issue.reviewStatus === "human_required" || issue.phase === "human-required") {
    if (latestReviewRunnerFailure(issue)) {
      return "inspect reviewer runner failure details and decide whether to redispatch, accept risk, or split follow-up work";
    }
    return "record `AgentOS-Human-Decision: fix-findings`, `approve-as-is`, `accept-risk`, `split-follow-up`, or `proceed-to-merge-after-supervisor-fix` in Linear before re-entry";
  }
  if (issue.phase === "merge") return "wait for merge shepherding or inspect GitHub checks if progress stalls";
  if (issue.validation?.status === "failed" || issue.validation?.status === "missing") return "repair or rerun validation evidence before Human Review handoff";
  if (issue.phase === "completed" && pullRequestUrls(issue).length === 0) return "review the no-PR handoff and move to Merging only if the outcome is accepted";
  return "inspect the latest handoff, validation evidence, PR state, and Linear comments";
}

export { daemonLaunchCommand, getDaemonStatus, inspectDaemonHealth };

function hasApprovedPullRequest(issue: IssueState): boolean {
  return issue.reviewStatus === "approved" && pullRequestUrls(issue).length > 0;
}

function isActiveCiRetryWait(issue: IssueState): boolean {
  return issue.ciRetry?.status === "requested" && issue.reviewStatus !== "approved" && issue.phase !== "completed" && issue.phase !== "merge";
}

function isSplitRecommendationAdvisory(issue: IssueState | null): boolean {
  return Boolean(issue && (issue.reviewStatus === "approved" || isAuthoritativeTerminalIssueState(issue)));
}

function isCommentReadDispatchStop(issue: IssueState): boolean {
  return /could not read latest Linear comments before dispatch guardrails/i.test(issue.stopReason ?? "");
}

function validationStatusPhrase(validation: ValidationState): string | null {
  const failedFullSuite = validation.failedHistoricalAttempts?.find((command) => command.name === "npm run agent-check");
  const focusedPass = validation.additionalPassingCommands?.find((command) => /^npm test --/.test(command.name));
  if (failedFullSuite && focusedPass && validation.githubCi?.status === "passed") {
    return `local full-suite validation timing failure recorded separately; focused test passed; GitHub CI passed${validation.githubCi.headSha ? ` at ${validation.githubCi.headSha}` : ""}`;
  }
  if (validation.status === "failed") return `validation failed${validation.errors?.length ? ` - ${validation.errors.join("; ")}` : ""}`;
  return null;
}

function ciRetryDetails(state: IssueState | null): string | null {
  const retry = state?.ciRetry;
  if (!retry) return "Flaky CI retry: none recorded";
  const attempts = retry.attempts.slice(-5).map((attempt) =>
    [
      `- ${attempt.status} ${attempt.attempt}/${attempt.maxAttempts} at ${attempt.attemptedAt}`,
      `  PR: ${attempt.prUrl}`,
      attempt.headSha ? `  Head: ${attempt.headSha}` : null,
      `  Checks: ${attempt.checkNames.join(", ") || "unknown"}`,
      `  Actions runs: ${attempt.runIds.join(", ") || "unknown"}`,
      `  Reason: ${attempt.reason}`,
      attempt.error ? `  Error: ${attempt.error}` : null
    ]
      .filter((line): line is string => line !== null)
      .join("\n")
  );
  return [`Flaky CI retry: ${retry.status} (${retry.updatedAt})`, ...attempts].join("\n");
}

function latestCiRetryAttempt(issue: IssueState): NonNullable<IssueState["ciRetry"]>["attempts"][number] | null {
  const attempts = issue.ciRetry?.attempts ?? [];
  return attempts.length ? attempts[attempts.length - 1] : null;
}

function latestReviewRunnerFailure(issue: IssueState): NonNullable<IssueState["reviewRunnerFailures"]>[number] | null {
  const failures = issue.reviewRunnerFailures ?? [];
  return failures.length ? failures[failures.length - 1] : null;
}

interface IssueStatusDiagnostic {
  message: string;
  nextAction: string;
}

const TERMINAL_LIFECYCLE_STATUSES = new Set<NonNullable<IssueState["lifecycleStatus"]>>([
  "merge_success",
  "post_merge_cleanup_warning",
  "terminal_linear",
  "already_merged_pr",
  "terminal_missing_workspace"
]);

function issueStatusDiagnostics(issue: IssueState, recovery: WorkspaceRecoveryDiagnostics | null, retry: RuntimeRetryEntry | null = null, active: RuntimeActiveRun | null = null): IssueStatusDiagnostic[] {
  const diagnostics: IssueStatusDiagnostic[] = [];
  const terminal = isTerminalIssueState(issue);
  if (issue.contextBudget?.status === "exceeded") {
    diagnostics.push({
      message: `context budget exceeded: ${issue.contextBudget.exceededReasons?.join("; ") ?? issue.contextBudget.summary}`,
      nextAction: "reduce prompt context by narrowing Active-Scope, pruning large artifacts, or splitting follow-up work before redispatch"
    });
  }
  if (terminal && active) {
    diagnostics.push({
      message: `active-run drift: terminal issue still has active runtime state${active.runId ? ` for ${active.runId}` : ""}${active.phase ? ` (${active.phase})` : ""}`,
      nextAction: terminalReconciliationAction()
    });
  }
  if (terminal && issue.reviewStatus === "human_required") {
    diagnostics.push({
      message: "contradictory terminal state: terminal issue still has reviewStatus human_required",
      nextAction: terminalReconciliationAction()
    });
  }
  if (terminal && (issue.lastError || issue.errorCategory)) {
    diagnostics.push({
      message: `contradictory terminal state: stale error metadata remains${issue.errorCategory ? ` (${issue.errorCategory})` : ""}${issue.lastError ? ` - ${issue.lastError}` : ""}`,
      nextAction: terminalReconciliationAction()
    });
  }
  const ciHeadSha = issue.validation?.githubCi?.headSha ?? null;
  const validationRepoHead = issue.validation?.repoHead ?? null;
  if (terminal && issue.headSha && validationRepoHead && issue.headSha !== validationRepoHead) {
    diagnostics.push({
      message: `contradictory terminal state: stale validation repoHead ${shortSha(validationRepoHead)} differs from recorded head ${shortSha(issue.headSha)}`,
      nextAction: "rerun or verify validation against the selected terminal head before relying on the stale evidence"
    });
  }
  if (terminal && issue.headSha && ciHeadSha && issue.headSha !== ciHeadSha) {
    diagnostics.push({
      message: `contradictory terminal state: stale validation/CI head SHA ${shortSha(ciHeadSha)} differs from recorded head ${shortSha(issue.headSha)}`,
      nextAction: "rerun or verify validation/CI against the selected terminal head before relying on the stale evidence"
    });
  }
  if (terminal && issue.validation?.githubCi?.status && issue.validation.githubCi.status !== "passed") {
    diagnostics.push({
      message: `contradictory terminal state: terminal issue still records GitHub CI as ${issue.validation.githubCi.status}`,
      nextAction: "verify the selected PR's latest checks before treating the terminal state as clean"
    });
  }
  if (terminal && (issue.nextRetryAt || issue.retryAttempt != null || retry)) {
    const retryDueAt = issue.nextRetryAt ?? retry?.dueAt;
    const retrySource = issue.nextRetryAt || issue.retryAttempt != null ? "retry metadata" : "retry queue entry";
    diagnostics.push({
      message: `merge/retry drift: terminal issue still has ${retrySource}${retryDueAt ? ` for ${retryDueAt}` : ""}`,
      nextAction: terminalReconciliationAction()
    });
  }
  if (terminal && shouldReportTerminalWorkspaceWarning(issue)) {
    diagnostics.push({
      message: `terminal workspace warning: workspace was missing during terminal reconciliation${issue.workspaceMissingAt ? ` at ${issue.workspaceMissingAt}` : ""}`,
      nextAction: "inspect the last handoff and run artifacts; do not start duplicate work solely to recreate the workspace"
    });
  }
  if (terminal && recovery && !recovery.exists && shouldReportMissingTerminalWorkspace(issue)) {
    diagnostics.push({
      message: `missing terminal workspace warning: workspacePath points to missing workspace ${recovery.workspacePath} but no terminal missing marker was recorded`,
      nextAction: "explain the missing workspace from run artifacts before redispatching or cleaning durable state"
    });
  }
  if (!terminal && recovery && !recovery.exists && issue.workspaceMissingAt) {
    diagnostics.push({
      message: `missing workspace warning: workspacePath points to missing workspace ${recovery.workspacePath}`,
      nextAction: recovery.nextSafeAction
    });
  }
  if (terminal && recovery?.recoverable) {
    diagnostics.push({
      message: `terminal workspace drift: terminal issue still points to recoverable workspace ${recovery.workspacePath} (${recovery.reasons.join("; ")})`,
      nextAction: terminalReconciliationAction()
    });
  }
  const cleanupDrift = cleanupDriftWarning(issue);
  if (cleanupDrift) {
    diagnostics.push({
      message: cleanupDrift,
      nextAction: "verify local and remote AgentOS branch cleanup manually or through the merge cleanup path; do not rerun implementation for cleanup drift"
    });
  }
  return diagnostics;
}

function findRuntimeActive(activeRuns: RuntimeActiveRun[], issue: Pick<IssueState, "issueId" | "issueIdentifier">): RuntimeActiveRun | null {
  return activeRuns.find((entry) => entry.issueId === issue.issueId || entry.identifier === issue.issueIdentifier) ?? null;
}

function findRuntimeRetry(retryQueue: RuntimeRetryEntry[], issue: Pick<IssueState, "issueId" | "issueIdentifier">): RuntimeRetryEntry | null {
  return retryQueue.find((entry) => entry.issueId === issue.issueId || entry.identifier === issue.issueIdentifier) ?? null;
}

function shouldFormatRecoveryDiagnostics(issue: IssueState | null, recovery: WorkspaceRecoveryDiagnostics | null): recovery is WorkspaceRecoveryDiagnostics {
  if (!recovery) return false;
  if (issue && isTerminalIssueState(issue) && recovery.recoverable) return false;
  if (issue && !recovery.exists && isExpectedTerminalWorkspaceCleanup(issue) && !shouldReportTerminalWorkspaceWarning(issue)) return false;
  return true;
}

function formatIssueStatusDiagnostic(diagnostic: IssueStatusDiagnostic): string {
  return `- ${diagnostic.message}\n  Next safe action: ${diagnostic.nextAction}`;
}

function isTerminalIssueState(issue: IssueState): boolean {
  return isAuthoritativeTerminalIssueState(issue);
}

function isAuthoritativeTerminalIssueState(issue: IssueState): boolean {
  return Boolean(
    issue.terminalState ||
      issue.mergedAt ||
      (issue.lifecycleStatus && TERMINAL_LIFECYCLE_STATUSES.has(issue.lifecycleStatus))
  );
}

function cleanTerminalStatusLine(issue: IssueState): string | null {
  if (!isAuthoritativeTerminalIssueState(issue)) return null;
  if (issue.lifecycleStatus === "already_merged_pr") return "already merged";
  if (issue.mergedAt || issue.lifecycleStatus === "merge_success" || issue.lifecycleStatus === "post_merge_cleanup_warning") return "merged";
  if (issue.terminalState) return `terminal (${issue.terminalState})`;
  return "terminal";
}

function cleanTerminalNextSafeAction(issue: IssueState): string | null {
  if (!isAuthoritativeTerminalIssueState(issue)) return null;
  if (issue.lifecycleStatus === "already_merged_pr") return "no operator action required; selected PR is already merged and terminal state is recorded";
  if (issue.mergedAt || issue.lifecycleStatus === "merge_success" || issue.lifecycleStatus === "post_merge_cleanup_warning") {
    return "no operator action required; selected PR is merged and terminal state is recorded";
  }
  if (issue.terminalState) return `no operator action required; issue is already in terminal state ${issue.terminalState}`;
  return "no operator action required; terminal state is recorded";
}

function hasTerminalWorkspaceWarning(issue: IssueState): boolean {
  return Boolean(issue.workspaceMissingAt || issue.lifecycleStatus === "terminal_missing_workspace");
}

function shouldReportTerminalWorkspaceWarning(issue: IssueState): boolean {
  if (!hasTerminalWorkspaceWarning(issue)) return false;
  return !isExpectedTerminalWorkspaceCleanup(issue);
}

function shouldReportMissingTerminalWorkspace(issue: IssueState): boolean {
  if (hasTerminalWorkspaceWarning(issue)) return false;
  return !isExpectedTerminalWorkspaceCleanup(issue);
}

function isExpectedTerminalWorkspaceCleanup(issue: IssueState): boolean {
  return Boolean(
    issue.mergedAt ||
      issue.lifecycleStatus === "merge_success" ||
      issue.lifecycleStatus === "post_merge_cleanup_warning" ||
      issue.lifecycleStatus === "already_merged_pr" ||
      issue.lifecycleStatus === "terminal_linear" ||
      issue.lifecycleStatus === "terminal_missing_workspace" ||
      (issue.phase === "completed" && Boolean(issue.terminalState))
  );
}

function cleanupDriftWarning(issue: IssueState): string | null {
  if (!issue.mergedAt && issue.lifecycleStatus !== "post_merge_cleanup_warning" && issue.lifecycleStatus !== "already_merged_pr") return null;
  const warnings = issue.mergeCleanupWarnings ?? [];
  if (warnings.length === 0) return null;
  const branchWarning = warnings.find((warning) => /(?:local|remote) branch cleanup|branch still exists|delete.*branch/i.test(warning)) ?? warnings[0];
  return `post-merge cleanup drift: selected PR is merged but AgentOS branch cleanup warning remains (${branchWarning})`;
}

function terminalReconciliationAction(): string {
  return "verify the terminal PR/Linear evidence, then use the reconciliation path to clear stale durable fields without redispatching Codex";
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}
