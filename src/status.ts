import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { daemonLaunchCommand, inspectDaemonHealth } from "./daemon-health.js";
import { IssueStateStore, latestHumanDecision, normalizeIssueState, pullRequestUrls } from "./issue-state.js";
import { JsonlLogger } from "./logging.js";
import { loadRegistry, RegistryStateStore, resolveRegistryProjectPaths, type RegistryProjectSummary } from "./registry.js";
import { formatRecoveryDiagnostics, inspectWorkspaceRecovery, type WorkspaceRecoveryDiagnostics } from "./recovery.js";
import { RuntimeStateStore, type RuntimeActiveRun, type RuntimeRetryEntry } from "./runtime-state.js";
import { loadWorkflow, resolveServiceConfig } from "./workflow.js";
import type { IssueState, ValidationCommandState, ValidationState } from "./types.js";

export async function getStatus(repo = process.cwd(), limit = 20): Promise<string> {
  const root = resolve(repo);
  const logger = new JsonlLogger(root);
  const entries = await logger.tail(limit);
  const daemon = await inspectDaemonHealth(root);
  const lines = [
    `Daemon: ${daemon.status} - ${daemon.message}`,
    `Next safe action: ${daemon.nextSafeAction}`,
    "",
    "Recent events:",
    entries.length
      ? entries
          .map((entry) => {
            const issue = entry.issueIdentifier ? ` ${entry.issueIdentifier}` : "";
            const message = entry.message ? ` - ${entry.message}` : "";
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
  const reviewArtifacts = (await exists(reviewRoot)) ? await listReviewArtifacts(reviewRoot) : [];
  const lines = [
    `Issue: ${identifier}`,
    state ? `Phase: ${state.phase ?? "unknown"}` : "Phase: unknown",
    state?.lifecycleStatus ? `Lifecycle: ${state.lifecycleStatus}` : null,
    state?.terminalState ? `Terminal state: ${state.terminalState}${state.terminalReason ? ` (${state.terminalReason})` : ""}` : null,
    prs.length ? `PRs:\n${prs.map((pr) => `- ${pr.url}${pr.role ? ` (${pr.role})` : ""}`).join("\n")}` : "PRs: none recorded",
    state?.reviewStatus ? `Review: ${state.reviewStatus}${state.reviewIteration ? ` iteration ${state.reviewIteration}` : ""}` : "Review: none recorded",
    humanDecisionDetails(state),
    appProofDetails(state),
    shouldFormatRecoveryDiagnostics(state, recovery) ? formatRecoveryDiagnostics(recovery).join("\n") : null,
    state ? `Next safe action: ${statusDiagnostics[0]?.nextAction ?? nextSafeAction(state, recovery)}` : null,
    state?.mergeTargetUrl ? `Merge target: ${state.mergeTargetUrl}${state.mergeTargetRole ? ` (${state.mergeTargetRole})` : ""}` : null,
    state?.mergeCleanupWarnings?.length ? `Merge cleanup warnings:\n${state.mergeCleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : null,
    statusDiagnostics.length ? `Status warnings:\n${statusDiagnostics.map(formatIssueStatusDiagnostic).join("\n")}` : "Status warnings: none",
    validationDetails(state?.validation),
    state?.lastError ? `Last error: ${state.lastError}` : null,
    state?.stopReason ? `Stop reason: ${state.stopReason}` : null,
    state?.nextRetryAt ? `Next retry: ${state.nextRetryAt}` : null,
    reviewArtifacts.length ? `Review artifacts:\n${reviewArtifacts.map((path) => `- ${path}`).join("\n")}` : "Review artifacts: none",
    "",
    "Recent events:",
    entries.length
      ? entries.map((entry) => `${entry.timestamp} ${entry.type}${entry.message ? ` - ${entry.message}` : ""}`).join("\n")
      : "No recent events for this issue."
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

async function listReviewArtifacts(root: string): Promise<string[]> {
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
  return out.sort();
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function validationDetails(validation: ValidationState | undefined): string {
  if (!validation) return "Validation: none recorded";
  const lines = [
    `Validation: ${validation.status}${validation.finalStatus ? ` (final: ${validation.finalStatus})` : ""}`,
    validation.acceptedCommands?.length ? `Accepted validation commands:\n${commandLines(validation.acceptedCommands)}` : null,
    validation.additionalPassingCommands?.length ? `Additional passing commands:\n${commandLines(validation.additionalPassingCommands)}` : null,
    validation.failedHistoricalAttempts?.length ? `Failed historical attempts:\n${commandLines(validation.failedHistoricalAttempts)}` : null,
    validation.githubCi ? `GitHub CI: ${validation.githubCi.status}${validation.githubCi.headSha ? ` (${validation.githubCi.headSha})` : ""}` : null,
    validation.errors?.length ? `Validation errors:\n${validation.errors.map((error) => `- ${error}`).join("\n")}` : null
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function humanDecisionDetails(state: IssueState | null): string | null {
  const decision = state?.lastHumanDecision ?? latestHumanDecision(state?.humanDecisions);
  if (!decision) return "Human decision: none recorded";
  const lines = [
    `Human decision: ${decision.type}`,
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

function commandLines(commands: ValidationCommandState[]): string {
  return commands
    .map((command) => `- ${command.name}: exitCode ${command.exitCode}, finished ${command.finishedAt}`)
    .join("\n");
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
  if (runtimeActive) return `running (${runtimeActive.phase ?? issue.phase ?? "active"})`;
  if (retry) return `retrying after ${retry.error ?? issue.lastError ?? "unknown error"}; next retry ${retry.dueAt}`;
  if (recovery?.recoverable) return `recoverable partial work - ${recovery.reasons.join("; ")}; next: ${recovery.nextSafeAction}`;
  const terminalStatus = cleanTerminalStatusLine(issue);
  if (terminalStatus) return terminalStatus;
  const mergeWaiting = [...logs].reverse().find((entry) => entry.issueIdentifier === issue.issueIdentifier && entry.type === "merge_waiting");
  if (mergeWaiting) return `waiting on CI - ${mergeWaiting.message ?? "selected PR checks are not ready"}`;
  const mergeFailed = [...logs].reverse().find((entry) => entry.issueIdentifier === issue.issueIdentifier && entry.type === "merge_failed");
  if (mergeFailed && issue.phase !== "completed") return `tracker/local disagreement or merge review needed - ${mergeFailed.message ?? "merge failed"}`;
  if (issue.lifecycleStatus === "planning_required") {
    return `planning required - ${nextSafeAction(issue, recovery)}`;
  }
  if (issue.lifecycleStatus === "human_continuation" || issue.lifecycleStatus === "supervisor_continuation" || issue.lifecycleStatus === "externally_fixed") {
    return `${issue.lifecycleStatus} - ${nextSafeAction(issue, recovery)}`;
  }
  if (issue.reviewStatus === "pending" || issue.phase === "review") return `waiting on review (${issue.reviewStatus ?? "pending"})`;
  if (issue.reviewStatus === "human_required" || issue.phase === "human-required") return `waiting on Human Review${issue.lastError ? ` - ${issue.lastError}` : ""}`;
  if (issue.phase === "merge") return "waiting on merge";
  if (pullRequestUrls(issue).length > 0 && issue.reviewStatus === "approved" && issue.phase === "completed") return "waiting on merge";
  if (issue.nextRetryAt) return `retrying after ${issue.lastError ?? "unknown error"}; next retry ${issue.nextRetryAt}`;
  if (issue.validation) {
    const validation = validationStatusPhrase(issue.validation);
    if (validation) return validation;
  }
  if (issue.phase === "completed") return "completed locally";
  return `${issue.phase ?? "recorded"}${issue.lastError ? ` - ${issue.lastError}` : ""}`;
}

function nextSafeAction(issue: IssueState, recovery: WorkspaceRecoveryDiagnostics | null = null): string {
  if (recovery?.recoverable) return recovery.nextSafeAction;
  const terminalAction = cleanTerminalNextSafeAction(issue);
  if (terminalAction) return terminalAction;
  const decision = issue.lastHumanDecision ?? latestHumanDecision(issue.humanDecisions);
  if (issue.lifecycleStatus === "planning_required" || /planning|decomposition|likely-large/i.test(issue.stopReason ?? "")) {
    return "create or attach a planning/decomposition artifact, or split follow-up issues, before returning the issue to implementation";
  }
  if (issue.lifecycleStatus === "externally_fixed" || decision?.type === "proceed_to_merge_after_supervisor_fix") {
    return "verify fresh validation and green CI, then move the issue to Merging; do not redispatch Codex unless a new fix-findings decision is recorded";
  }
  if (decision?.type === "fix_findings") {
    return "redispatch from Todo/In Progress with recent Linear comments, PR feedback, and review context included in the next prompt";
  }
  if (decision?.type === "approve_as_is" || decision?.type === "accept_risk" || decision?.type === "split_follow_up") {
    return "keep Codex paused; move to Merging only when remaining risk is accepted and required validation/CI evidence is fresh";
  }
  if (issue.reviewStatus === "human_required" || issue.phase === "human-required") {
    return "record `AgentOS-Human-Decision: fix-findings`, `approve-as-is`, `accept-risk`, `split-follow-up`, or `proceed-to-merge-after-supervisor-fix` in Linear before re-entry";
  }
  if (issue.reviewStatus === "approved" && pullRequestUrls(issue).length > 0) {
    return "mark the PR ready only after fresh validation and green CI, then move the issue to Merging for the shepherd";
  }
  if (issue.phase === "merge") return "wait for merge shepherding or inspect GitHub checks if progress stalls";
  if (issue.validation?.status === "failed" || issue.validation?.status === "missing") return "repair or rerun validation evidence before Human Review handoff";
  if (issue.phase === "completed" && pullRequestUrls(issue).length === 0) return "review the no-PR handoff and move to Merging only if the outcome is accepted";
  return "inspect the latest handoff, validation evidence, PR state, and Linear comments";
}

export { daemonLaunchCommand, inspectDaemonHealth };

function validationStatusPhrase(validation: ValidationState): string | null {
  const failedFullSuite = validation.failedHistoricalAttempts?.find((command) => command.name === "npm run agent-check");
  const focusedPass = validation.additionalPassingCommands?.find((command) => /^npm test --/.test(command.name));
  if (failedFullSuite && focusedPass && validation.githubCi?.status === "passed") {
    return `local full-suite validation timing failure recorded separately; focused test passed; GitHub CI passed${validation.githubCi.headSha ? ` at ${validation.githubCi.headSha}` : ""}`;
  }
  if (validation.status === "failed") return `validation failed${validation.errors?.length ? ` - ${validation.errors.join("; ")}` : ""}`;
  return null;
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
  if (terminal && hasTerminalWorkspaceWarning(issue)) {
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
  if (issue && !recovery.exists && isExpectedPostMergeWorkspaceCleanup(issue) && !hasTerminalWorkspaceWarning(issue)) return false;
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

function shouldReportMissingTerminalWorkspace(issue: IssueState): boolean {
  if (hasTerminalWorkspaceWarning(issue)) return false;
  return !isExpectedPostMergeWorkspaceCleanup(issue);
}

function isExpectedPostMergeWorkspaceCleanup(issue: IssueState): boolean {
  return Boolean(
    issue.mergedAt ||
      issue.lifecycleStatus === "merge_success" ||
      issue.lifecycleStatus === "post_merge_cleanup_warning" ||
      issue.lifecycleStatus === "already_merged_pr"
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
