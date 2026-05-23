import { join, relative, resolve } from "node:path";
import { exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import { assertPullRequestUrlMatchesRepo } from "./github-repository.js";
import { extractPullRequestUrls, issueStateFromHandoff, IssueStateStore, pullRequestUrls } from "./issue-state.js";
import { validateLifecycleConfig } from "./lifecycle.js";
import { isLinearIdentifier } from "./linear.js";
import type { LinearCommentWriteResult, LinearIssueReference } from "./linear.js";
import { redactText } from "./redaction.js";
import type { HumanDecisionFindingsState, HumanDecisionType, Issue, LifecycleDuplicateCommentBehavior, PullRequestRef, ServiceConfig } from "./types.js";
import { workspaceKey } from "./workspace.js";

export const DEFAULT_AGENT_TRACKER_MARKER_FORMAT = "<!-- agentos:event={event} issue={issue} -->";

const supervisorDecisionLabels: Record<HumanDecisionType, string> = {
  approve_as_is: "approve-as-is",
  fix_findings: "fix-findings",
  accept_risk: "accept-risk",
  split_follow_up: "split-follow-up",
  proceed_to_merge_after_supervisor_fix: "proceed-to-merge-after-supervisor-fix"
};

const supervisorCiStates = ["passed", "failed", "pending"] as const;
type SupervisorCiState = (typeof supervisorCiStates)[number];
const supervisorFindingsStates = ["resolved", "accepted", "open"] as const satisfies HumanDecisionFindingsState[];

export interface AgentLifecycleTracker {
  findIssueReference(issueIdentifierOrId: string): Promise<LinearIssueReference>;
  upsertCommentWithMarker(
    issueIdentifierOrId: string,
    body: string,
    marker: string,
    duplicateBehavior?: LifecycleDuplicateCommentBehavior
  ): Promise<LinearCommentWriteResult>;
  move(issueIdentifierOrId: string, stateName: string): Promise<void>;
}

export interface AgentLifecycleContext {
  repoRoot: string;
  config: ServiceConfig;
  tracker: AgentLifecycleTracker;
}

export interface AgentLifecycleToolOptions {
  issue: string;
  tool: string;
  event?: string;
  runId?: string;
  attempt?: number | null;
  supervisor?: boolean;
}

export interface AgentCommentInput extends AgentLifecycleToolOptions {
  body: string;
}

export interface AgentMoveInput extends AgentLifecycleToolOptions {
  state: string;
}

export interface AgentAttachPrInput extends AgentLifecycleToolOptions {
  prUrl: string;
}

export interface AgentRecordHandoffInput extends AgentLifecycleToolOptions {
  handoffPath: string;
}

export interface AgentLifecycleResult {
  status: "created" | "updated" | "skipped" | "moved" | "recorded";
  issueIdentifier: string;
  marker?: string;
  fallbackPath?: string;
  runId?: string;
  attempt?: number | null;
}

export interface SupervisorDecisionBodyInput {
  decisionType: string;
  prHeadSha: string;
  validationPath: string;
  ciState: string;
  findings: string;
  summary: string;
  issueIdentifier?: string;
}

export interface SupervisorValidationEvidenceInput {
  evidenceText: string;
  validationPath: string;
  issueIdentifier: string;
  prHeadSha: string;
}

export async function commentWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentCommentInput
): Promise<AgentLifecycleResult> {
  assertLifecycleTrackerWriteAllowed(context.config, input);
  if (input.supervisor) assertSupervisorIssueIdentifier(input.issue);
  const issue = await context.tracker.findIssueReference(input.issue);
  if (input.supervisor) {
    validateSupervisorCommentBody(input.body, issue.identifier);
  }
  const marker = agentTrackerMarker(context.config, input.event ?? "agent_comment", issue.identifier, input);
  const body = redactText(input.body);
  return runLifecycleOperation(context, issue.identifier, input, "comment", async () => {
    const status = await context.tracker.upsertCommentWithMarker(
      issue.identifier,
      body,
      marker,
      duplicateCommentBehavior(context.config)
    );
    return withLifecycleCorrelation({ status, issueIdentifier: issue.identifier, marker }, input);
  });
}

export async function moveWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentMoveInput
): Promise<AgentLifecycleResult> {
  assertLifecycleTrackerWriteAllowed(context.config, input);
  if (input.supervisor) assertSupervisorIssueIdentifier(input.issue);
  const issue = await context.tracker.findIssueReference(input.issue);
  if (input.supervisor) {
    assertKnownWorkflowState(context.config, input.state);
  } else {
    assertAllowedTransition(context.config, issue.state, input.state);
  }
  if (sameState(issue.state, input.state)) {
    return withLifecycleCorrelation({ status: "skipped", issueIdentifier: issue.identifier }, input);
  }
  return runLifecycleOperation(context, issue.identifier, input, "move", async () => {
    await context.tracker.move(issue.identifier, input.state);
    return withLifecycleCorrelation({ status: "moved", issueIdentifier: issue.identifier }, input);
  });
}

export async function attachPrWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentAttachPrInput
): Promise<AgentLifecycleResult> {
  assertLifecycleTrackerWriteAllowed(context.config, input);
  if (input.supervisor) assertSupervisorIssueIdentifier(input.issue);
  const issue = await context.tracker.findIssueReference(input.issue);
  const marker = agentTrackerMarker(context.config, input.event ?? "pr_metadata", issue.identifier, input);
  await assertPullRequestUrlMatchesRepo(context.repoRoot, input.prUrl);
  const now = new Date().toISOString();
  const pr: PullRequestRef = { url: input.prUrl, discoveredAt: now, source: "manual" };
  const state = await new IssueStateStore(context.repoRoot).merge(issue.identifier, {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    prs: [pr],
    prUrl: pr.url
  });
  const body = redactText(["### AgentOS PR metadata", "", ...pullRequestUrls(state).map((url) => `- PR: ${url}`)].join("\n"));
  return runLifecycleOperation(context, issue.identifier, input, "attach-pr", async () => {
    const status = await context.tracker.upsertCommentWithMarker(
      issue.identifier,
      body,
      marker,
      duplicateCommentBehavior(context.config)
    );
    return withLifecycleCorrelation({ status, issueIdentifier: issue.identifier, marker }, input);
  });
}

export async function recordHandoffWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentRecordHandoffInput
): Promise<AgentLifecycleResult> {
  assertLifecycleTrackerWriteAllowed(context.config, input);
  if (input.supervisor) assertSupervisorIssueIdentifier(input.issue);
  const issue = await context.tracker.findIssueReference(input.issue);
  const marker = agentTrackerMarker(context.config, input.event ?? "run_handoff", issue.identifier, input);
  assertExpectedHandoffPath(context.repoRoot, input.handoffPath, issue.identifier);
  const handoff = redactText(await readText(input.handoffPath));
  await assertHandoffPullRequestsMatchRepo(context.repoRoot, handoff);
  const issueState = issueStateFromHandoff(toIssue(issue), handoff);
  if (issueState) {
    await new IssueStateStore(context.repoRoot).merge(issue.identifier, issueState);
  }
  return runLifecycleOperation(context, issue.identifier, input, "record-handoff", async () => {
    const status = await context.tracker.upsertCommentWithMarker(
      issue.identifier,
      handoff,
      marker,
      duplicateCommentBehavior(context.config)
    );
    return withLifecycleCorrelation({ status, issueIdentifier: issue.identifier, marker }, input);
  });
}

export function agentTrackerMarker(config: ServiceConfig, event: string, issueIdentifier: string, correlation: { runId?: string; attempt?: number | null } = {}): string {
  const format = config.lifecycle.idempotencyMarkerFormat ?? DEFAULT_AGENT_TRACKER_MARKER_FORMAT;
  return format
    .split("{event}")
    .join(stableMarkerToken(event, "event"))
    .split("{issue}")
    .join(stableMarkerToken(issueIdentifier, "issue"))
    .split("{run}")
    .join(stableMarkerToken(correlation.runId ?? "manual", "run"))
    .split("{attempt}")
    .join(stableMarkerToken(correlation.attempt == null ? "manual" : String(correlation.attempt), "attempt"));
}

export function assertAgentTrackerWriteAllowed(config: ServiceConfig, tool: string): void {
  if (config.lifecycle.mode === "orchestrator-owned") {
    throw new Error("lifecycle.mode=orchestrator-owned rejects agent tracker writes; use hybrid or agent-owned mode");
  }
  if (config.lifecycle.mode === "agent-owned") {
    const validation = validateLifecycleConfig(config.lifecycle, true);
    if (validation.errors.length > 0) {
      throw new Error(validation.errors.join("; "));
    }
  }
  if (config.lifecycle.allowedTrackerTools.length === 0) {
    throw new Error("lifecycle.allowed_tracker_tools is required for agent tracker writes");
  }
  const normalizedTool = normalizeToolName(tool);
  const allowed = config.lifecycle.allowedTrackerTools.map(normalizeToolName);
  if (!allowed.includes(normalizedTool)) {
    throw new Error(`lifecycle.allowed_tracker_tools does not include ${tool}`);
  }
}

export function buildSupervisorDecisionBody(input: SupervisorDecisionBodyInput): string {
  const decisionType = normalizeSupervisorDecisionType(input.decisionType);
  const prHeadSha = normalizeSupervisorPrHeadSha(input.prHeadSha);
  const ciState = normalizeSupervisorCiState(input.ciState);
  const findings = normalizeSupervisorFindings(input.findings);
  const validationPath = input.validationPath.trim();
  const summary = input.summary.trim();
  if (!validationPath) throw new Error("supervisor decision requires Validation-JSON");
  if (!summary) throw new Error("supervisor decision requires Decision-Summary");
  if (input.issueIdentifier) assertExpectedSupervisorValidationPath(validationPath, input.issueIdentifier);
  const body = [
    `AgentOS-Human-Decision: ${supervisorDecisionLabels[decisionType]}`,
    `PR-Head-SHA: ${prHeadSha}`,
    `Validation-JSON: ${validationPath}`,
    `CI-State: ${ciState}`,
    `Findings: ${findings}`,
    `Decision-Summary: ${summary}`
  ].join("\n");
  validateSupervisorDecisionBody(body, input.issueIdentifier);
  return body;
}

export function assertSupervisorValidationEvidence(input: SupervisorValidationEvidenceInput): void {
  let evidence: unknown;
  try {
    evidence = JSON.parse(input.evidenceText);
  } catch (error) {
    throw new Error(`supervisor validation evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!evidence || typeof evidence !== "object") {
    throw new Error("supervisor validation evidence must be a JSON object");
  }
  const raw = evidence as Record<string, unknown>;
  if (raw.schemaVersion !== 1) throw new Error("supervisor validation evidence schemaVersion must be 1");
  if (raw.issueIdentifier !== input.issueIdentifier) {
    throw new Error(`supervisor validation evidence issueIdentifier mismatch: expected ${input.issueIdentifier}`);
  }
  if (typeof raw.repoHead !== "string" || !raw.repoHead.trim()) {
    throw new Error("supervisor validation evidence repoHead is required");
  }
  if (raw.status !== "passed") {
    throw new Error("supervisor validation evidence status must be passed");
  }
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    throw new Error("supervisor validation evidence commands must be a non-empty array");
  }
  const prHeadSha = normalizeSupervisorPrHeadSha(input.prHeadSha);
  if (!sameSha(raw.repoHead, prHeadSha)) {
    throw new Error(`supervisor validation evidence repoHead must match PR-Head-SHA ${prHeadSha}`);
  }
  if (!raw.reuseProfile || typeof raw.reuseProfile !== "object") {
    throw new Error("supervisor validation evidence reuseProfile is required");
  }
  const reuseProfile = raw.reuseProfile as Record<string, unknown>;
  for (const key of ["workflowConfigHash", "trustMode", "automationProfile", "automationRepairPolicy", "riskProfile"]) {
    if (typeof reuseProfile[key] !== "string" || !reuseProfile[key].trim()) {
      throw new Error(`supervisor validation evidence reuseProfile.${key} is required`);
    }
  }
  assertExpectedSupervisorValidationPath(input.validationPath, input.issueIdentifier);
}

export function supervisorDecisionEvent(decisionType: string, prHeadSha: string): string {
  const normalized = supervisorDecisionLabels[normalizeSupervisorDecisionType(decisionType)];
  return `supervisor-decision:${normalized}:${normalizeSupervisorPrHeadSha(prHeadSha).slice(0, 12)}`;
}

export function assertAllowedTransition(config: ServiceConfig, fromState: string, toState: string): void {
  if (sameState(fromState, toState)) return;
  const transitions = config.lifecycle.allowedStateTransitions.map(parseAllowedStateTransition);
  if (transitions.length === 0) {
    throw new Error("lifecycle.allowed_state_transitions is required for agent tracker moves");
  }
  const from = normalizeState(fromState);
  const to = normalizeState(toState);
  if (!transitions.some((transition) => normalizeState(transition.from) === from && normalizeState(transition.to) === to)) {
    throw new Error(`disallowed_tracker_state_transition: ${fromState} -> ${toState}`);
  }
}

export function parseAllowedStateTransition(value: string): { from: string; to: string } {
  const match = value.match(/^\s*(.+?)\s*->\s*(.+?)\s*$/);
  if (!match) throw new Error(`invalid_allowed_state_transition: ${value}`);
  return { from: match[1], to: match[2] };
}

function assertLifecycleTrackerWriteAllowed(config: ServiceConfig, input: AgentLifecycleToolOptions): void {
  if (input.supervisor) return;
  assertAgentTrackerWriteAllowed(config, input.tool);
  if (config.lifecycle.mode === "agent-owned") {
    if (!input.runId?.trim()) {
      throw new Error("lifecycle.mode=agent-owned requires --run-id for agent tracker writes");
    }
    stableMarkerToken(input.runId, "run");
    if (input.attempt == null) {
      throw new Error("lifecycle.mode=agent-owned requires --attempt for agent tracker writes");
    }
    if (!Number.isInteger(input.attempt) || input.attempt < 0) {
      throw new Error("lifecycle.mode=agent-owned requires --attempt to be a non-negative integer");
    }
  }
}

export function assertSupervisorIssueIdentifier(value: string): void {
  if (!isLinearIdentifier(value)) {
    throw new Error("supervisor Linear helpers require a human-readable issue identifier like VER-104; refusing raw Linear IDs");
  }
}

function assertKnownWorkflowState(config: ServiceConfig, state: string): void {
  const knownStates = workflowKnownStates(config);
  if (!knownStates.some((known) => sameState(known, state))) {
    throw new Error(`unknown workflow state for supervisor move: ${state}; known states: ${knownStates.join(", ")}`);
  }
}

function workflowKnownStates(config: ServiceConfig): string[] {
  return uniqueStrings([
    ...config.tracker.activeStates,
    ...config.tracker.terminalStates,
    config.tracker.runningState,
    config.tracker.reviewState,
    config.tracker.mergeState,
    config.tracker.needsInputState,
    config.github.doneState
  ]);
}

function validateSupervisorCommentBody(body: string, issueIdentifier: string): void {
  if (!/^AgentOS-Human-Decision:/im.test(body)) return;
  validateSupervisorDecisionBody(body, issueIdentifier);
}

function validateSupervisorDecisionBody(body: string, issueIdentifier?: string): void {
  const fields = supervisorDecisionFields(body);
  const requiredFields = ["AgentOS-Human-Decision", "PR-Head-SHA", "Validation-JSON", "CI-State", "Findings", "Decision-Summary"];
  for (const field of requiredFields) {
    if (!fields.get(field)?.trim()) throw new Error(`supervisor decision requires ${field}`);
  }
  normalizeSupervisorDecisionType(fields.get("AgentOS-Human-Decision") ?? "");
  normalizeSupervisorPrHeadSha(fields.get("PR-Head-SHA") ?? "");
  normalizeSupervisorCiState(fields.get("CI-State") ?? "");
  normalizeSupervisorFindings(fields.get("Findings") ?? "");
  if (issueIdentifier) assertExpectedSupervisorValidationPath(fields.get("Validation-JSON") ?? "", issueIdentifier);
}

function supervisorDecisionFields(body: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^(AgentOS-Human-Decision|PR-Head-SHA|Validation-JSON|CI-State|Findings|Decision-Summary):\s*(.*)$/);
    if (!match) continue;
    fields.set(match[1], match[2].trim());
  }
  return fields;
}

function normalizeSupervisorDecisionType(value: string): HumanDecisionType {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "approve_as_is") return "approve_as_is";
  if (normalized === "fix_findings") return "fix_findings";
  if (normalized === "accept_risk") return "accept_risk";
  if (normalized === "split_follow_up") return "split_follow_up";
  if (normalized === "proceed_to_merge_after_supervisor_fix") return "proceed_to_merge_after_supervisor_fix";
  throw new Error(`unsupported supervisor decision type: ${value}`);
}

function normalizeSupervisorPrHeadSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(normalized)) {
    throw new Error("supervisor decision requires PR-Head-SHA to be a 7-64 character hexadecimal git SHA");
  }
  return normalized;
}

function normalizeSupervisorCiState(value: string): SupervisorCiState {
  const normalized = value.trim().toLowerCase();
  if (supervisorCiStates.includes(normalized as SupervisorCiState)) return normalized as SupervisorCiState;
  throw new Error("supervisor decision CI-State must be passed, failed, or pending");
}

function normalizeSupervisorFindings(value: string): (typeof supervisorFindingsStates)[number] {
  const normalized = value.trim().toLowerCase();
  if (supervisorFindingsStates.includes(normalized as (typeof supervisorFindingsStates)[number])) {
    return normalized as (typeof supervisorFindingsStates)[number];
  }
  throw new Error("supervisor decision Findings must be resolved, accepted, or open");
}

function assertExpectedSupervisorValidationPath(validationPath: string, issueIdentifier: string): void {
  const issueToken = stableMarkerToken(issueIdentifier, "issue");
  const expected = `.agent-os/validation/${issueToken}.json`;
  const expectedWorkspacePath = `.agent-os/workspaces/${workspaceKey(issueIdentifier)}/.agent-os/validation/${issueToken}.json`;
  const normalized = validationPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized !== expected && normalized !== expectedWorkspacePath) {
    throw new Error(`supervisor decision Validation-JSON must be ${expected} or ${expectedWorkspacePath}`);
  }
}

function runLifecycleOperation(
  context: AgentLifecycleContext,
  issueIdentifier: string,
  input: AgentLifecycleToolOptions,
  operation: string,
  fn: () => Promise<AgentLifecycleResult>
): Promise<AgentLifecycleResult> {
  return input.supervisor ? fn() : runWithFallback(context, issueIdentifier, input.tool, operation, fn);
}

function withLifecycleCorrelation(result: AgentLifecycleResult, input: AgentLifecycleToolOptions): AgentLifecycleResult {
  return {
    ...result,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.attempt != null ? { attempt: input.attempt } : {})
  };
}

async function runWithFallback(
  context: AgentLifecycleContext,
  issueIdentifier: string,
  tool: string,
  operation: string,
  fn: () => Promise<AgentLifecycleResult>
): Promise<AgentLifecycleResult> {
  try {
    return await fn();
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    const fallbackPath = await writeFallbackHandoff(context, issueIdentifier, operation, tool, message);
    throw new Error(`agent_tracker_tool_failed: ${operation}: ${message}${fallbackPath ? `; fallback=${fallbackPath}` : ""}`);
  }
}

async function writeFallbackHandoff(
  context: AgentLifecycleContext,
  issueIdentifier: string,
  operation: string,
  tool: string,
  reason: string
): Promise<string | null> {
  if (!context.config.lifecycle.fallbackBehavior?.toLowerCase().includes("handoff")) return null;
  const safeIssue = stableMarkerToken(issueIdentifier, "issue");
  const path = join(context.repoRoot, ".agent-os", `handoff-${safeIssue}.md`);
  if (await exists(path)) return path;
  await writeTextEnsuringDir(
    path,
    [
      "AgentOS-Outcome: partially-satisfied",
      "",
      "### Tracker Tool Fallback",
      "",
      "The repo-local Linear lifecycle tool could not complete a tracker write.",
      "",
      `- Operation: ${operation}`,
      `- Tool: ${tool}`,
      `- Issue: ${issueIdentifier}`,
      `- Reason: ${reason}`,
      "",
      "Smallest next human decision: inspect the tracker credentials/tooling and decide whether to retry the lifecycle write."
    ].join("\n") + "\n"
  );
  return path;
}

function duplicateCommentBehavior(config: ServiceConfig): LifecycleDuplicateCommentBehavior {
  return config.lifecycle.duplicateCommentBehavior ?? "upsert";
}

function stableMarkerToken(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) {
    throw new Error(`${label} must contain only letters, numbers, dot, underscore, colon, or hyphen`);
  }
  return trimmed;
}

function normalizeToolName(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

function normalizeState(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    byKey.set(trimmed.toLowerCase(), trimmed);
  }
  return [...byKey.values()];
}

function sameSha(left: unknown, right: string): boolean {
  return typeof left === "string" && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sameState(a: string, b: string): boolean {
  return normalizeState(a) === normalizeState(b);
}

function assertExpectedHandoffPath(repoRoot: string, handoffPath: string, issueIdentifier: string): void {
  const expected = resolve(repoRoot, ".agent-os", `handoff-${stableMarkerToken(issueIdentifier, "issue")}.md`);
  const actual = resolve(repoRoot, handoffPath);
  if (actual !== expected) {
    throw new Error(`handoff file must be ${relative(repoRoot, expected)}`);
  }
}

async function assertHandoffPullRequestsMatchRepo(repoRoot: string, handoff: string): Promise<void> {
  for (const url of extractPullRequestUrls(handoff)) {
    await assertPullRequestUrlMatchesRepo(repoRoot, url);
  }
}

function toIssue(issue: LinearIssueReference): Issue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.identifier,
    description: null,
    priority: null,
    state: issue.state,
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}
