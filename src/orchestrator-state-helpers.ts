import { spawn } from "node:child_process";
import { join } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { mergeEligiblePullRequests, pullRequestUrls } from "./issue-state.js";
import type { RunSummary } from "./runs.js";
import type { RuntimeActiveRun } from "./runtime-state.js";
import type { Issue, IssueState, ServiceConfig, Workspace } from "./types.js";

export function validationFailureMessage(validation: NonNullable<IssueState["validation"]>): string {
  const reason = validation.errors?.length ? validation.errors.join("; ") : `status=${validation.status}`;
  return `validation_failed: ${reason}`;
}

export function issueFromState(state: IssueState): Issue {
  return {
    id: state.issueId,
    identifier: state.issueIdentifier,
    title: state.issueIdentifier,
    description: null,
    priority: null,
    state: state.terminalState ?? "",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: state.updatedAt
  };
}

export function issueFromRunSummary(summary: RunSummary): Issue {
  return {
    id: summary.issueId,
    identifier: summary.issueIdentifier,
    title: summary.issueIdentifier,
    description: null,
    priority: null,
    state: "",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: summary.startedAt
  };
}

export function workspaceFromRuntime(active: RuntimeActiveRun, summary: RunSummary | undefined, workspaceRoot: string): Workspace {
  const workspaceKey = active.workspaceKey ?? active.identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    path: active.workspacePath ?? summary?.workspacePath ?? join(workspaceRoot, workspaceKey),
    workspaceKey,
    createdNow: false
  };
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export async function readHandoff(workspacePath: string, identifier: string): Promise<string | null> {
  const path = join(workspacePath, ".agent-os", `handoff-${identifier}.md`);
  if (!(await exists(path))) return null;
  const text = await readText(path);
  return text.trim() ? text : null;
}

export function gitRevParse(cwd: string, ref: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", cwd, "rev-parse", ref], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => resolvePromise(code === 0 ? stdout.trim() || null : null));
  });
}

export function gitLsRemoteBranch(cwd: string, remote: string, branch: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["-C", cwd, "ls-remote", remote, `refs/heads/${branch}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => {
      if (code !== 0) return resolvePromise(null);
      const sha = stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[0])
        .find(Boolean);
      resolvePromise(sha ?? null);
    });
  });
}

export function isNoPrHandoffApproved(state: IssueState): boolean {
  const validationPassed = state.validation?.finalStatus === "passed" || state.validation?.status === "passed";
  const hasOnlyNonMergePrOutputs = pullRequestUrls(state).length > 0 && mergeEligiblePullRequests(state).length === 0;
  return state.phase === "completed" && validationPassed && (state.outcome === "already_satisfied" || hasOnlyNonMergePrOutputs);
}

export function isLocallySettledIssueState(state: IssueState): boolean { return state.phase === "completed" || state.phase === "canceled" || state.phase === "human-required" || state.reviewStatus === "human_required"; }

export function isLocallyCompletedState(state: IssueState): boolean { return state.phase === "completed" || state.outcome === "already_satisfied"; }

export function completedDispatchStopReason(state: IssueState): string {
  if (state.outcome === "already_satisfied") return "work is already satisfied by prior AgentOS handoff";
  if (pullRequestUrls(state).length > 0) return "work is already completed locally and has recorded pull request metadata";
  return "work is already completed locally and should not be redispatched";
}

export function completionMarker(issue: Issue): string { return issue.updated_at ?? `${issue.state}:${issue.title}`; }
export function displayAttempt(attempt: number | null): number { return (attempt ?? 0) + 1; }

export function isStateIn(state: string, states: string[]): boolean {
  const normalized = state.toLowerCase();
  return states.map((item) => item.toLowerCase()).includes(normalized);
}

export function runningAllowedStates(config: ServiceConfig): string[] { return [...config.tracker.activeStates, config.tracker.runningState].filter((state): state is string => Boolean(state)); }
