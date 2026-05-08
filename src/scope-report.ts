import { isAbsolute, join, relative, resolve } from "node:path";
import { exists } from "./fs-utils.js";
import { pullRequestUrls } from "./issue-state.js";
import { inspectWorkspaceRecovery, type WorkspaceRecoveryDiagnostics } from "./recovery.js";
import { RunArtifactStore, type RunSummary } from "./runs.js";
import { RuntimeStateStore, type RuntimeActiveRun, type RuntimeRetryEntry, type RuntimeState } from "./runtime-state.js";
import { workspaceKey } from "./workspace.js";
import type { AgentEvent, Issue, IssueState, PullRequestRole, ValidationState } from "./types.js";

export type ScopeImplementationStatus = "already_satisfied" | "partially_satisfied" | "missing" | "unclear";
export type ScopeImpact = "none" | "low" | "medium" | "high" | "unclear";
export type ScopeLikelihood = "existing_pr" | "pr_likely" | "no_pr_likely" | "unclear";
export type ScopeSize = "small" | "medium" | "large" | "unclear";

export interface PreDispatchScopeReport {
  schemaVersion: 1;
  issueId: string;
  issueIdentifier: string;
  generatedAt: string;
  implementationStatus: ScopeImplementationStatus;
  implementationStatusReasons: string[];
  likelyTouchedSubsystems: string[];
  docsImpact: ScopeImpact;
  testsImpact: ScopeImpact;
  prLikelihood: ScopeLikelihood;
  reviewRisk: ScopeImpact;
  scopeSize: ScopeSize;
  likelyLarge: boolean;
  scopeReasons: string[];
  evidence: ScopeEvidence;
  dispatchAdvice: {
    shouldBlock: false;
    notes: string[];
  };
}

export interface ScopeEvidence {
  issueText: {
    hasDescription: boolean;
    acceptanceBulletCount: number;
    labelCount: number;
  };
  state: {
    present: boolean;
    outcome: IssueState["outcome"] | null;
    phase: IssueState["phase"] | null;
    lastError: string | null;
    stopReason: string | null;
  };
  workspace: {
    present: boolean;
    path: string | null;
    branch: string | null;
    headSha: string | null;
    dirty: boolean;
    upstreamMissing: boolean;
    aheadCount: number;
    recoverable: boolean;
    reasons: string[];
  };
  pullRequests: {
    present: boolean;
    count: number;
    urls: string[];
    roles: PullRequestRole[];
  };
  validation: {
    present: boolean;
    status: ValidationState["status"] | null;
    finalStatus: NonNullable<ValidationState["finalStatus"]> | null;
    latestCommand: string | null;
    latestCommandFinishedAt: string | null;
  };
  handoff: {
    present: boolean;
    workspacePath: string | null;
    runArtifactPath: string | null;
  };
  runtime: {
    activeRunPresent: boolean;
    retryPresent: boolean;
    runId: string | null;
    phase: string | null;
    lastEventAt: string | null;
    retryAttempt: number | null;
    retryError: string | null;
  };
  lastRun: {
    present: boolean;
    runId: string | null;
    status: string | null;
    stopReason: string | null;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    lastEventAt: string | null;
    latestEventType: string | null;
    latestEventAt: string | null;
    eventCount: number;
    tokenInput: number | null;
    tokenOutput: number | null;
    tokenTotal: number | null;
    latestCommandActivity: CommandActivityEvidence | null;
    quietValidationStop: boolean;
  };
}

export interface CommandActivityEvidence {
  type: string;
  timestamp: string;
  command: string | null;
  exitCode: number | null;
  outputSeen: boolean;
  validationCommand: boolean;
}

interface BuildScopeReportInput {
  repoRoot: string;
  issue: Issue;
  state?: IssueState | null;
  runtime?: RuntimeState;
  workspaceRoot?: string;
  now?: string;
}

interface ScopeReportLogger {
  write(entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string }): Promise<unknown>;
}

interface LogScopeReportInput extends BuildScopeReportInput {
  logger: ScopeReportLogger;
  runtime: RuntimeState;
  workspaceRoot: string;
}

interface LastRunEvidence {
  summary: RunSummary | null;
  runId: string | null;
  events: AgentEvent[];
  latestCommandActivity: CommandActivityEvidence | null;
  quietValidationStop: boolean;
}

export async function buildPreDispatchScopeReport(input: BuildScopeReportInput): Promise<PreDispatchScopeReport> {
  const repoRoot = resolve(input.repoRoot);
  const generatedAt = input.now ?? new Date().toISOString();
  const runtime = input.runtime ?? (await new RuntimeStateStore(repoRoot).read());
  const activeRun = findRuntimeActive(runtime.activeRuns, input.issue);
  const retry = findRuntimeRetry(runtime.retryQueue, input.issue);
  const workspacePath = await resolveWorkspacePath(repoRoot, input.issue, input.state ?? null, activeRun, retry, input.workspaceRoot ?? ".agent-os/workspaces");
  const recovery = workspacePath
    ? await inspectWorkspaceRecovery(repoRoot, {
        issueIdentifier: input.issue.identifier,
        workspacePath,
        headSha: input.state?.headSha ?? null,
        validation: input.state?.validation
      }).catch(() => null)
    : null;
  const lastRun = await readLastRunEvidence(repoRoot, input.issue, input.state ?? null, activeRun, retry);
  const handoff = await readHandoffEvidence(repoRoot, input.issue, workspacePath, lastRun.runId);
  const evidence = buildEvidence(repoRoot, input.issue, input.state ?? null, recovery, handoff, activeRun, retry, lastRun);
  const implementation = classifyImplementationStatus(input.issue, input.state ?? null, evidence);
  const likelyTouchedSubsystems = estimateTouchedSubsystems(input.issue, input.state ?? null, evidence);
  const scope = estimateScope(input.issue, implementation.status, likelyTouchedSubsystems, evidence);
  const prLikelihood = estimatePrLikelihood(input.issue, implementation.status, evidence);
  const report: PreDispatchScopeReport = {
    schemaVersion: 1,
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    generatedAt,
    implementationStatus: implementation.status,
    implementationStatusReasons: implementation.reasons,
    likelyTouchedSubsystems,
    docsImpact: estimateDocsImpact(input.issue, implementation.status, likelyTouchedSubsystems),
    testsImpact: estimateTestsImpact(input.issue, implementation.status, likelyTouchedSubsystems),
    prLikelihood,
    reviewRisk: estimateReviewRisk(scope.scopeSize, likelyTouchedSubsystems, evidence, implementation.status),
    scopeSize: scope.scopeSize,
    likelyLarge: scope.scopeSize === "large",
    scopeReasons: scope.reasons,
    evidence,
    dispatchAdvice: {
      shouldBlock: false,
      notes: dispatchNotes(implementation.status, scope.scopeSize, evidence)
    }
  };
  return report;
}

export function preDispatchScopeReportMessage(report: PreDispatchScopeReport): string {
  const large = report.likelyLarge ? "; likely large" : "";
  return `implementation=${report.implementationStatus}; scope=${report.scopeSize}; pr=${report.prLikelihood}; review=${report.reviewRisk}${large}`;
}

export async function logPreDispatchScopeReport(input: LogScopeReportInput): Promise<void> {
  try {
    const report = await buildPreDispatchScopeReport(input);
    await input.logger.write({
      type: "pre_dispatch_scope_report",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: preDispatchScopeReportMessage(report),
      payload: report
    });
  } catch (error) {
    await input.logger.write({
      type: "pre_dispatch_scope_report_warning",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: `pre-dispatch scope report failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

function buildEvidence(
  repoRoot: string,
  issue: Issue,
  state: IssueState | null,
  recovery: WorkspaceRecoveryDiagnostics | null,
  handoff: ScopeEvidence["handoff"],
  activeRun: RuntimeActiveRun | null,
  retry: RuntimeRetryEntry | null,
  lastRun: LastRunEvidence
): ScopeEvidence {
  const prs = pullRequestUrls(state);
  const validationCommand = latestValidationCommand(state?.validation ?? null);
  const latestEvent = lastRun.events.at(-1) ?? null;
  const summary = lastRun.summary;
  return {
    issueText: {
      hasDescription: Boolean(issue.description?.trim()),
      acceptanceBulletCount: acceptanceBulletCount(issue.description),
      labelCount: issue.labels.length
    },
    state: {
      present: Boolean(state),
      outcome: state?.outcome ?? null,
      phase: state?.phase ?? null,
      lastError: state?.lastError ?? null,
      stopReason: state?.stopReason ?? null
    },
    workspace: {
      present: Boolean(recovery?.exists),
      path: recovery ? relativeToRepo(repoRoot, recovery.workspacePath) : null,
      branch: recovery?.branch ?? null,
      headSha: recovery?.headSha ?? null,
      dirty: recovery?.dirty ?? false,
      upstreamMissing: recovery?.upstreamMissing ?? false,
      aheadCount: recovery?.aheadCount ?? 0,
      recoverable: recovery?.recoverable ?? false,
      reasons: recovery?.reasons ?? []
    },
    pullRequests: {
      present: prs.length > 0,
      count: prs.length,
      urls: prs,
      roles: (state?.prs ?? []).map((pr) => pr.role ?? "supporting")
    },
    validation: {
      present: Boolean(state?.validation),
      status: state?.validation?.status ?? null,
      finalStatus: state?.validation?.finalStatus ?? null,
      latestCommand: validationCommand?.name ?? null,
      latestCommandFinishedAt: validationCommand?.finishedAt ?? null
    },
    handoff,
    runtime: {
      activeRunPresent: Boolean(activeRun),
      retryPresent: Boolean(retry),
      runId: activeRun?.runId ?? retry?.runId ?? null,
      phase: activeRun?.phase ?? null,
      lastEventAt: activeRun?.lastEventAt ?? null,
      retryAttempt: retry?.attempt ?? null,
      retryError: retry?.error ?? null
    },
    lastRun: {
      present: Boolean(summary || lastRun.runId),
      runId: summary?.runId ?? lastRun.runId,
      status: summary?.status ?? null,
      stopReason: summary?.stopReason ?? state?.stopReason ?? activeRun?.stopReason ?? retry?.error ?? null,
      error: summary?.error ?? state?.lastError ?? retry?.error ?? null,
      startedAt: summary?.startedAt ?? null,
      finishedAt: summary?.finishedAt ?? null,
      lastEventAt: summary?.lastEventAt ?? null,
      latestEventType: latestEvent?.type ?? null,
      latestEventAt: latestEvent?.timestamp ?? null,
      eventCount: lastRun.events.length,
      tokenInput: summary?.metrics.tokens.input ?? null,
      tokenOutput: summary?.metrics.tokens.output ?? null,
      tokenTotal: summary?.metrics.tokens.total ?? null,
      latestCommandActivity: lastRun.latestCommandActivity,
      quietValidationStop: lastRun.quietValidationStop
    }
  };
}

async function resolveWorkspacePath(
  repoRoot: string,
  issue: Issue,
  state: IssueState | null,
  activeRun: RuntimeActiveRun | null,
  retry: RuntimeRetryEntry | null,
  workspaceRoot: string
): Promise<string | null> {
  if (state?.workspacePath) return state.workspacePath;
  if (activeRun?.workspacePath) return activeRun.workspacePath;
  if (retry?.workspacePath) return retry.workspacePath;
  const candidate = join(workspaceRoot, workspaceKey(issue.identifier));
  return (await exists(resolve(repoRoot, candidate))) ? candidate : null;
}

async function readLastRunEvidence(
  repoRoot: string,
  issue: Issue,
  state: IssueState | null,
  activeRun: RuntimeActiveRun | null,
  retry: RuntimeRetryEntry | null
): Promise<LastRunEvidence> {
  const store = new RunArtifactStore(repoRoot);
  const summaries = await store.listRuns().catch(() => []);
  const relevant = summaries.filter((summary) => summary.issueId === issue.id || summary.issueIdentifier === issue.identifier);
  const preferredRunId = state?.lastRunId ?? activeRun?.runId ?? retry?.runId ?? relevant.at(-1)?.runId ?? null;
  const summary = preferredRunId ? summaries.find((candidate) => candidate.runId === preferredRunId) ?? null : relevant.at(-1) ?? null;
  const runId = summary?.runId ?? preferredRunId;
  const events = runId ? await store.replay(runId).catch(() => []) : [];
  const latestCommandActivity = latestCommandActivityFromEvents(events);
  return {
    summary,
    runId,
    events,
    latestCommandActivity,
    quietValidationStop: isQuietValidationStop(summary, state, retry, latestCommandActivity)
  };
}

async function readHandoffEvidence(repoRoot: string, issue: Issue, workspacePath: string | null, runId: string | null): Promise<ScopeEvidence["handoff"]> {
  const workspaceHandoff = workspacePath ? resolve(repoRoot, workspacePath, ".agent-os", `handoff-${issue.identifier}.md`) : null;
  const runHandoff = runId ? join(repoRoot, ".agent-os", "runs", runId, "handoff.md") : null;
  const workspacePresent = workspaceHandoff ? await exists(workspaceHandoff) : false;
  const runPresent = runHandoff ? await exists(runHandoff) : false;
  return {
    present: workspacePresent || runPresent,
    workspacePath: workspacePresent && workspaceHandoff ? relativeToRepo(repoRoot, workspaceHandoff) : null,
    runArtifactPath: runPresent && runHandoff ? relativeToRepo(repoRoot, runHandoff) : null
  };
}

function classifyImplementationStatus(issue: Issue, state: IssueState | null, evidence: ScopeEvidence): { status: ScopeImplementationStatus; reasons: string[] } {
  if (state?.outcome === "already_satisfied") {
    return { status: "already_satisfied", reasons: ["prior handoff recorded AgentOS-Outcome: already-satisfied"] };
  }
  if (state?.outcome === "partially_satisfied") {
    return { status: "partially_satisfied", reasons: ["prior handoff recorded AgentOS-Outcome: partially-satisfied"] };
  }
  if (evidence.workspace.recoverable) {
    return { status: "partially_satisfied", reasons: ["recoverable workspace evidence exists", ...evidence.workspace.reasons] };
  }
  if (evidence.pullRequests.present) {
    return { status: "partially_satisfied", reasons: ["pull request metadata already exists"] };
  }
  if (state?.outcome === "implemented") {
    return { status: "partially_satisfied", reasons: ["prior handoff recorded implemented work"] };
  }
  if (evidence.handoff.present || evidence.validation.present) {
    return { status: "partially_satisfied", reasons: ["handoff or validation evidence already exists"] };
  }
  if (evidence.runtime.activeRunPresent || evidence.runtime.retryPresent || evidence.lastRun.present) {
    return { status: "partially_satisfied", reasons: ["runtime or run evidence already exists"] };
  }
  if (isUnclearIssue(issue)) {
    return { status: "unclear", reasons: ["issue text lacks enough concrete acceptance detail to classify missing work"] };
  }
  return { status: "missing", reasons: ["no prior implementation, PR, validation, handoff, runtime, or recoverable workspace evidence found"] };
}

function estimateTouchedSubsystems(issue: Issue, state: IssueState | null, evidence: ScopeEvidence): string[] {
  const text = issueText(issue);
  const matches: string[] = [];
  const keywordMap: Array<[string, RegExp]> = [
    ["orchestration", /\b(orchestrator|scheduler|dispatch|candidate|retry|reconciliation|lifecycle|linear)\b/i],
    ["runner-runtime", /\b(codex|app server|runner|stall|timeout|token|event volume|runtime)\b/i],
    ["workspace-recovery", /\b(workspace|worktree|branch|upstream|dirty|recoverable)\b/i],
    ["github-pr", /\b(github|pull request| pr |checks?|ci|merge)\b/i],
    ["validation", /\b(validation|agent-check|test|vitest|typecheck|build)\b/i],
    ["harness-templates", /\b(harness|template|profile|skill|agent[s]?\.md)\b/i],
    ["workflow-docs", /\b(workflow|readme|architecture|docs?|quality|runbook)\b/i],
    ["cli", /\b(cli|command|commander|agent-os)\b/i],
    ["security", /\b(security|secret|credential|trust|auth|token)\b/i],
    ["registry", /\b(registry|multi-project|project registry|daemon)\b/i]
  ];
  for (const [subsystem, pattern] of keywordMap) {
    if (pattern.test(text)) matches.push(subsystem);
  }
  if (state?.validation || evidence.lastRun.quietValidationStop) matches.push("validation");
  if (evidence.workspace.recoverable) matches.push("workspace-recovery");
  if (evidence.pullRequests.present) matches.push("github-pr");
  return unique(matches).length ? unique(matches) : ["unknown"];
}

function estimateScope(
  issue: Issue,
  implementationStatus: ScopeImplementationStatus,
  likelyTouchedSubsystems: string[],
  evidence: ScopeEvidence
): { scopeSize: ScopeSize; reasons: string[] } {
  if (implementationStatus === "already_satisfied") {
    return { scopeSize: "small", reasons: ["prior handoff says no implementation work is needed"] };
  }
  if (implementationStatus === "unclear") {
    return { scopeSize: "unclear", reasons: ["scope cannot be estimated from current evidence"] };
  }

  const text = issueText(issue);
  const concreteSubsystems = likelyTouchedSubsystems.filter((subsystem) => subsystem !== "unknown");
  const reasons: string[] = [];
  let score = 0;
  if (concreteSubsystems.length >= 3) {
    score += concreteSubsystems.length;
    reasons.push(`touches ${concreteSubsystems.length} likely subsystem(s)`);
  }
  if (evidence.issueText.acceptanceBulletCount >= 5) {
    score += 2;
    reasons.push(`has ${evidence.issueText.acceptanceBulletCount} acceptance/detail bullet(s)`);
  }
  if (/\b(end-to-end|roadmap|migration|architecture|orchestrator|workflow|all|every|large|broad|dependencies|decompose|guardrail)\b/i.test(text)) {
    score += 2;
    reasons.push("contains broad orchestration or roadmap language");
  }
  if (text.length > 1200) {
    score += 1;
    reasons.push("issue text is long");
  }
  if (evidence.lastRun.eventCount > 200 || (evidence.lastRun.tokenTotal ?? 0) > 100_000) {
    score += 2;
    reasons.push("prior run had high event or token volume");
  }
  if (evidence.workspace.recoverable) {
    score += 1;
    reasons.push("recoverable partial workspace must be preserved");
  }

  if (score >= 5) return { scopeSize: "large", reasons };
  if (score >= 2) return { scopeSize: "medium", reasons: reasons.length ? reasons : ["moderate subsystem or acceptance detail"] };
  return { scopeSize: "small", reasons: reasons.length ? reasons : ["limited issue text and few subsystem signals"] };
}

function estimateDocsImpact(issue: Issue, implementationStatus: ScopeImplementationStatus, likelyTouchedSubsystems: string[]): ScopeImpact {
  if (implementationStatus === "already_satisfied") return "none";
  if (implementationStatus === "unclear") return "unclear";
  const text = issueText(issue);
  if (/\b(docs?|readme|architecture|workflow|runbook|quality|agents?\.md)\b/i.test(text)) return "high";
  if (likelyTouchedSubsystems.some((subsystem) => subsystem === "workflow-docs" || subsystem === "harness-templates")) return "medium";
  return "low";
}

function estimateTestsImpact(issue: Issue, implementationStatus: ScopeImplementationStatus, likelyTouchedSubsystems: string[]): ScopeImpact {
  if (implementationStatus === "already_satisfied") return "none";
  if (implementationStatus === "unclear") return "unclear";
  const text = issueText(issue);
  if (/\b(test|vitest|coverage|validation|agent-check|typecheck|build)\b/i.test(text)) return "high";
  if (likelyTouchedSubsystems.length === 1 && likelyTouchedSubsystems[0] === "workflow-docs") return "low";
  return "medium";
}

function estimatePrLikelihood(issue: Issue, implementationStatus: ScopeImplementationStatus, evidence: ScopeEvidence): ScopeLikelihood {
  if (evidence.pullRequests.present) return "existing_pr";
  if (implementationStatus === "already_satisfied") return "no_pr_likely";
  if (implementationStatus === "unclear") return "unclear";
  const text = issueText(issue);
  const investigationOnly = /\b(investigate|audit|research|planning-only|investigation-only|read-only report)\b/i.test(text) && !/\b(add|implement|fix|change|update|create)\b/i.test(text);
  return investigationOnly ? "no_pr_likely" : "pr_likely";
}

function estimateReviewRisk(scopeSize: ScopeSize, likelyTouchedSubsystems: string[], evidence: ScopeEvidence, implementationStatus: ScopeImplementationStatus): ScopeImpact {
  if (implementationStatus === "already_satisfied") return "low";
  if (implementationStatus === "unclear" || scopeSize === "unclear") return "unclear";
  const highRiskSubsystems = new Set(["orchestration", "runner-runtime", "github-pr", "security"]);
  if (scopeSize === "large" || likelyTouchedSubsystems.some((subsystem) => highRiskSubsystems.has(subsystem))) return "high";
  if (scopeSize === "medium" || evidence.workspace.recoverable || likelyTouchedSubsystems.length > 1) return "medium";
  return "low";
}

function dispatchNotes(implementationStatus: ScopeImplementationStatus, scopeSize: ScopeSize, evidence: ScopeEvidence): string[] {
  const notes = ["report-only: dispatch is not blocked by this scope report"];
  if (scopeSize === "large") notes.push("likely-large scope is surfaced for operator visibility only");
  if (implementationStatus === "partially_satisfied") notes.push("preserve existing partial-work evidence before starting a fresh implementation path");
  if (evidence.workspace.dirty && evidence.workspace.upstreamMissing) notes.push("dirty workspace with no upstream is recoverable partial work, not fresh missing work");
  if (evidence.lastRun.quietValidationStop) notes.push("last run appears to have stopped during a quiet validation command");
  return notes;
}

function latestCommandActivityFromEvents(events: AgentEvent[]): CommandActivityEvidence | null {
  let latest: CommandActivityEvidence | null = null;
  for (const event of events) {
    const command = commandFromEvent(event);
    if (command) {
      latest = {
        type: event.type,
        timestamp: event.timestamp,
        command: command.command,
        exitCode: command.exitCode,
        outputSeen: command.outputSeen,
        validationCommand: isValidationCommand(command.command)
      };
      continue;
    }
    if (latest && isCommandOutputEvent(event)) latest.outputSeen = true;
  }
  return latest;
}

function commandFromEvent(event: AgentEvent): { command: string; exitCode: number | null; outputSeen: boolean } | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  const item = nestedRecord(payload, ["params", "item"]) ?? nestedRecord(payload, ["item"]);
  const payloadCommand = stringValue(nestedValue(payload, ["command"])) ?? stringValue(item?.command);
  if (!payloadCommand) return null;
  const exitCode = numberOrNull(nestedValue(payload, ["exitCode"]) ?? item?.exitCode);
  const outputSeen = Boolean(stringValue(item?.output)?.trim());
  return { command: payloadCommand, exitCode, outputSeen };
}

function isCommandOutputEvent(event: AgentEvent): boolean {
  if (event.type === "codex_stdout" || event.type === "codex_stderr") return true;
  return /commandExecution\/outputDelta|command_output|output_delta/i.test(event.type);
}

function isQuietValidationStop(
  summary: RunSummary | null,
  state: IssueState | null,
  retry: RuntimeRetryEntry | null,
  latestCommandActivity: CommandActivityEvidence | null
): boolean {
  const stop = [summary?.status, summary?.stopReason, summary?.error, state?.stopReason, state?.lastError, retry?.error].filter(Boolean).join(" ");
  return /\b(stall|stalled|timeout|timed_out|codex_stall_timeout|codex_turn_timeout)\b/i.test(stop) && Boolean(latestCommandActivity?.validationCommand) && !latestCommandActivity?.outputSeen;
}

function latestValidationCommand(validation: ValidationState | null): { name: string; finishedAt: string } | null {
  const commands = [...(validation?.acceptedCommands ?? []), ...(validation?.additionalPassingCommands ?? []), ...(validation?.failedHistoricalAttempts ?? [])];
  return commands.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1) ?? null;
}

function acceptanceBulletCount(description: string | null): number {
  return (description ?? "").split(/\r?\n/).filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
}

function isUnclearIssue(issue: Issue): boolean {
  const text = issueText(issue);
  if (!issue.description?.trim() && /\b(investigate|unclear|tbd|unknown|weird|something|figure out)\b/i.test(text)) return true;
  if (text.trim().length < 32) return true;
  return false;
}

function issueText(issue: Issue): string {
  return [issue.title, issue.description, issue.labels.join(" ")].filter(Boolean).join("\n");
}

function isValidationCommand(command: string | null): boolean {
  return Boolean(command && /\b(npm\s+run\s+agent-check|npm\s+test|vitest|typecheck|tsc|build|validation|agent-check)\b/i.test(command));
}

function findRuntimeActive(activeRuns: RuntimeActiveRun[], issue: Issue): RuntimeActiveRun | null {
  return activeRuns.find((entry) => entry.issueId === issue.id || entry.identifier === issue.identifier) ?? null;
}

function findRuntimeRetry(retryQueue: RuntimeRetryEntry[], issue: Issue): RuntimeRetryEntry | null {
  return retryQueue.find((entry) => entry.issueId === issue.id || entry.identifier === issue.identifier) ?? null;
}

function nestedRecord(value: unknown, path: string[]): Record<string, unknown> | null {
  const nested = nestedValue(value, path);
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function relativeToRepo(repoRoot: string, path: string): string {
  const normalizedRoot = resolve(repoRoot);
  const normalizedPath = resolve(path);
  const relativePath = relative(normalizedRoot, normalizedPath);
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : normalizedPath;
}
