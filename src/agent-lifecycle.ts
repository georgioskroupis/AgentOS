import { join, relative, resolve } from "node:path";
import { exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import { assertPullRequestUrlMatchesRepo } from "./github-repository.js";
import { extractPullRequestUrls, issueStateFromHandoff, IssueStateStore, pullRequestUrls } from "./issue-state.js";
import { validateLifecycleConfig } from "./lifecycle.js";
import type { LinearCommentWriteResult, LinearIssueReference } from "./linear.js";
import { redactText } from "./redaction.js";
import type { Issue, LifecycleDuplicateCommentBehavior, PullRequestRef, ServiceConfig } from "./types.js";

export const DEFAULT_AGENT_TRACKER_MARKER_FORMAT = "<!-- agentos:event={event} issue={issue} -->";

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
}

export async function commentWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentCommentInput
): Promise<AgentLifecycleResult> {
  assertAgentTrackerWriteAllowed(context.config, input.tool);
  const issue = await context.tracker.findIssueReference(input.issue);
  const marker = agentTrackerMarker(context.config, input.event ?? "agent_comment", issue.identifier);
  const body = redactText(input.body);
  return runWithFallback(context, issue.identifier, input.tool, "comment", async () => {
    const status = await context.tracker.upsertCommentWithMarker(
      issue.identifier,
      body,
      marker,
      duplicateCommentBehavior(context.config)
    );
    return { status, issueIdentifier: issue.identifier, marker };
  });
}

export async function moveWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentMoveInput
): Promise<AgentLifecycleResult> {
  assertAgentTrackerWriteAllowed(context.config, input.tool);
  const issue = await context.tracker.findIssueReference(input.issue);
  assertAllowedTransition(context.config, issue.state, input.state);
  if (sameState(issue.state, input.state)) {
    return { status: "skipped", issueIdentifier: issue.identifier };
  }
  return runWithFallback(context, issue.identifier, input.tool, "move", async () => {
    await context.tracker.move(issue.identifier, input.state);
    return { status: "moved", issueIdentifier: issue.identifier };
  });
}

export async function attachPrWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentAttachPrInput
): Promise<AgentLifecycleResult> {
  assertAgentTrackerWriteAllowed(context.config, input.tool);
  const issue = await context.tracker.findIssueReference(input.issue);
  const marker = agentTrackerMarker(context.config, input.event ?? "pr_metadata", issue.identifier);
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
  return runWithFallback(context, issue.identifier, input.tool, "attach-pr", async () => {
    const status = await context.tracker.upsertCommentWithMarker(
      issue.identifier,
      body,
      marker,
      duplicateCommentBehavior(context.config)
    );
    return { status, issueIdentifier: issue.identifier, marker };
  });
}

export async function recordHandoffWithAgentLifecycleTool(
  context: AgentLifecycleContext,
  input: AgentRecordHandoffInput
): Promise<AgentLifecycleResult> {
  assertAgentTrackerWriteAllowed(context.config, input.tool);
  const issue = await context.tracker.findIssueReference(input.issue);
  const marker = agentTrackerMarker(context.config, input.event ?? "run_handoff", issue.identifier);
  assertExpectedHandoffPath(context.repoRoot, input.handoffPath, issue.identifier);
  const handoff = redactText(await readText(input.handoffPath));
  await assertHandoffPullRequestsMatchRepo(context.repoRoot, handoff);
  const issueState = issueStateFromHandoff(toIssue(issue), handoff);
  if (issueState) {
    await new IssueStateStore(context.repoRoot).merge(issue.identifier, issueState);
  }
  return runWithFallback(context, issue.identifier, input.tool, "record-handoff", async () => {
    const status = await context.tracker.upsertCommentWithMarker(
      issue.identifier,
      handoff,
      marker,
      duplicateCommentBehavior(context.config)
    );
    return { status, issueIdentifier: issue.identifier, marker };
  });
}

export function agentTrackerMarker(config: ServiceConfig, event: string, issueIdentifier: string): string {
  const format = config.lifecycle.idempotencyMarkerFormat ?? DEFAULT_AGENT_TRACKER_MARKER_FORMAT;
  return format
    .split("{event}")
    .join(stableMarkerToken(event, "event"))
    .split("{issue}")
    .join(stableMarkerToken(issueIdentifier, "issue"));
}

export function assertAgentTrackerWriteAllowed(config: ServiceConfig, tool: string): void {
  if (config.lifecycle.mode === "orchestrator-owned") {
    throw new Error("lifecycle.mode=orchestrator-owned rejects agent tracker writes; use hybrid or experimental agent-owned mode");
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
