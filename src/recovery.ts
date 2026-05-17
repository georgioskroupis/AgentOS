import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  clearedFailureMetadataPatch,
  issueStateFromHandoff,
  IssueStateStore,
  mergeTargetAmbiguityReason,
  mergeTargetPullRequest,
  normalizeIssueState,
  previousFailureFromIssueState,
  reviewTargetPullRequests
} from "./issue-state.js";
import { RuntimeStateStore } from "./runtime-state.js";
import { validationEvidencePath, verifyValidationEvidence } from "./validation.js";
import { workspaceKey } from "./workspace.js";
import type { Issue, IssueState, OperatorRecoveryState } from "./types.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceRecoveryDiagnostics {
  workspacePath: string;
  exists: boolean;
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  upstreamMissing: boolean;
  aheadCount: number;
  behindCount: number;
  stalePrHead: boolean;
  staleCiHead: boolean;
  recoverable: boolean;
  reasons: string[];
  nextSafeAction: string;
}

export interface RecordOperatorRecoveryInput {
  repoRoot: string;
  issueIdentifier: string;
  workspacePath?: string;
  handoffPath?: string;
  runId?: string;
  now?: string;
}

export interface OperatorRecoveryRecordResult {
  issueIdentifier: string;
  branch: string;
  headSha: string;
  workspacePath: string;
  handoffPath: string;
  validationPath: string | null;
  proofArtifacts: OperatorRecoveryState["proofArtifacts"];
  state: IssueState;
}

export class OperatorRecoveryRefusal extends Error {
  constructor(
    message: string,
    readonly nextSafeAction: string
  ) {
    super(`recovery refused: ${message}\nNext safe action: ${nextSafeAction}`);
    this.name = "OperatorRecoveryRefusal";
  }
}

export async function inspectWorkspaceRecovery(repoRoot: string, issue: Pick<IssueState, "workspacePath" | "headSha" | "validation" | "issueIdentifier"> | null | undefined): Promise<WorkspaceRecoveryDiagnostics | null> {
  if (!issue?.workspacePath) return null;
  const workspacePath = resolve(repoRoot, issue.workspacePath);
  const exists = await pathExists(workspacePath);
  if (!exists) {
    return {
      workspacePath,
      exists: false,
      branch: null,
      headSha: null,
      dirty: false,
      upstreamMissing: false,
      aheadCount: 0,
      behindCount: 0,
      stalePrHead: false,
      staleCiHead: false,
      recoverable: false,
      reasons: ["workspace is missing"],
      nextSafeAction: "inspect runtime state and recover from the last handoff or run artifact; do not start a duplicate implementation until the missing workspace is explained"
    };
  }

  const branch = await gitOutput(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headSha = await gitOutput(workspacePath, ["rev-parse", "HEAD"]);
  const status = await gitOutput(workspacePath, ["status", "--porcelain"]);
  const upstreamSha = await gitOutput(workspacePath, ["rev-parse", "--verify", "@{u}"]);
  const baseSha = await gitOutput(workspacePath, ["rev-parse", "--verify", "origin/main"]).then((sha) => sha ?? gitOutput(workspacePath, ["rev-parse", "--verify", "main"]));
  const aheadRaw = upstreamSha ? await gitOutput(workspacePath, ["rev-list", "--count", "@{u}..HEAD"]) : null;
  const behindRaw = upstreamSha ? await gitOutput(workspacePath, ["rev-list", "--count", "HEAD..@{u}"]) : null;
  const dirty = Boolean(status?.trim());
  const upstreamMissing = Boolean(branch && branch !== "HEAD" && !upstreamSha);
  const aheadCount = Number.parseInt(aheadRaw ?? "0", 10) || 0;
  const behindCount = Number.parseInt(behindRaw ?? "0", 10) || 0;
  const stalePrHead = Boolean(issue.headSha && headSha && issue.headSha !== headSha);
  const ciHeadSha = issue.validation?.githubCi?.headSha ?? null;
  const staleCiHead = Boolean(ciHeadSha && headSha && ciHeadSha !== headSha);
  const cleanBaseWithoutUpstream = Boolean(upstreamMissing && !dirty && headSha && baseSha && headSha === baseSha);
  const branchSyncReason =
    aheadCount > 0 && behindCount > 0
      ? `branch has diverged from upstream (${aheadCount} commit(s) ahead, ${behindCount} commit(s) behind)`
      : aheadCount > 0
        ? `branch is ${aheadCount} commit(s) ahead of upstream`
        : behindCount > 0
          ? `branch is ${behindCount} commit(s) behind upstream`
          : null;
  const reasons = [
    dirty ? "workspace has uncommitted changes" : null,
    upstreamMissing && !cleanBaseWithoutUpstream ? "branch has no upstream" : null,
    branchSyncReason,
    stalePrHead ? `local HEAD ${headSha} differs from recorded PR head ${issue.headSha}` : null,
    staleCiHead ? `local HEAD ${headSha} differs from recorded CI head ${ciHeadSha}` : null
  ].filter((item): item is string => item !== null);
  const recoverable = reasons.length > 0;

  return {
    workspacePath,
    exists,
    branch,
    headSha,
    dirty,
    upstreamMissing,
    aheadCount,
    behindCount,
    stalePrHead,
    staleCiHead,
    recoverable,
    reasons,
    nextSafeAction: recoverable
      ? `resume ${workspacePath}, preserve existing changes, run validation, then commit and push the existing branch before updating the handoff or PR`
      : `reuse ${workspacePath} for any follow-up; rerun validation before changing Linear state`
  };
}

export async function recordOperatorRecovery(input: RecordOperatorRecoveryInput): Promise<OperatorRecoveryRecordResult> {
  const repoRoot = resolve(input.repoRoot);
  const issueIdentifier = input.issueIdentifier;
  const stateStore = new IssueStateStore(repoRoot);
  const current = await stateStore.read(issueIdentifier);
  const workspacePath = await resolveRecoveryWorkspace(repoRoot, issueIdentifier, current, input.workspacePath);
  const diagnostics = await inspectWorkspaceRecovery(repoRoot, {
    issueIdentifier,
    workspacePath,
    headSha: current?.headSha ?? null,
    validation: current?.validation
  });
  assertRecoveryEvidenceCanBeRecorded(diagnostics, workspacePath);

  const branch = diagnostics.branch;
  const headSha = diagnostics.headSha;
  const handoffPath = resolveRecoveryHandoff(repoRoot, workspacePath, issueIdentifier, input.handoffPath);
  if (!(await pathExists(handoffPath))) {
    throw new OperatorRecoveryRefusal(
      `handoff evidence is missing at ${handoffPath}`,
      `write the recovered handoff to ${join(workspacePath, ".agent-os", `handoff-${issueIdentifier}.md`)} or pass --handoff with the recovered handoff path`
    );
  }
  if (!pathInside(workspacePath, handoffPath)) {
    throw new OperatorRecoveryRefusal(
      `handoff evidence ${handoffPath} is outside selected workspace ${workspacePath}`,
      "place the recovered handoff in the selected workspace or pass --workspace for the worktree that owns this handoff"
    );
  }

  const handoff = await readFile(handoffPath, "utf8");
  const issue = issueForRecovery(issueIdentifier, current);
  const handoffState = issueStateFromHandoff(issue, handoff);
  if (!handoffState?.outcome) {
    throw new OperatorRecoveryRefusal(
      "handoff evidence does not record AgentOS-Outcome",
      `add AgentOS-Outcome and Validation-JSON lines to ${relativeToRepo(repoRoot, handoffPath)} before recording recovery`
    );
  }
  if (handoffState.outcome === "partially_satisfied") {
    throw new OperatorRecoveryRefusal(
      "handoff outcome is partially-satisfied and cannot be recorded as successful recovery",
      `finish the recovered work, write an implemented or already-satisfied handoff, rerun validation, and record recovery again`
    );
  }
  const mergeAmbiguity = mergeTargetAmbiguityReason(handoffState);
  if (mergeAmbiguity) {
    throw new OperatorRecoveryRefusal(
      `handoff pull request evidence is ambiguous: ${mergeAmbiguity}`,
      "mark exactly one merge-eligible pull request as Primary PR or remove ambiguous PR roles from the handoff"
    );
  }

  const validationMarker = validationEvidencePath(handoff);
  const validation = await verifyValidationEvidence({
    issue,
    handoff,
    workspacePath,
    runId: input.runId,
    allowReusableRunEvidence: true
  });
  if (validation.state.status !== "passed") {
    throw new OperatorRecoveryRefusal(
      validation.state.errors?.join("; ") ?? `validation evidence is ${validation.state.status}`,
      `rerun validation in ${workspacePath}, update ${validationMarker ?? `.agent-os/validation/${issueIdentifier}.json`}, and record recovery again`
    );
  }

  const recordedAt = input.now ?? new Date().toISOString();
  const acceptedRunId = input.runId ?? validation.state.runId;
  const workspaceRelativePath = relativeToRepo(repoRoot, workspacePath);
  const handoffRelativePath = relativeToRepo(repoRoot, handoffPath);
  const validationRelativePath = validation.state.path ? relativeToRepo(repoRoot, validation.state.path) : validationMarker;
  const previousFailure = previousFailureFromIssueState(current) ?? current?.operatorRecovery?.previousFailure;
  const handoffPrs = handoffState.prs ?? [];
  const reviewTargetMode = current?.reviewTargetMode ?? "merge-eligible";
  const mergeTarget = handoffPrs.length ? mergeTargetPullRequest(handoffState) : null;
  const prState: Partial<IssueState> = handoffPrs.length
    ? {
        prs: handoffPrs,
        prUrl: handoffState.prUrl,
        reviewTargetMode,
        reviewTargetUrls: reviewTargetPullRequests(handoffState, reviewTargetMode).map((pr) => pr.url),
        mergeTargetUrl: mergeTarget?.url,
        mergeTargetRole: mergeTarget?.role
      }
    : {
        prs: undefined,
        prUrl: undefined,
        reviewTargetMode: undefined,
        reviewTargetUrls: undefined,
        mergeTargetUrl: undefined,
        mergeTargetRole: undefined
      };
  const operatorRecovery: OperatorRecoveryState = {
    recordedAt,
    runId: acceptedRunId,
    branch,
    headSha,
    workspacePath: workspaceRelativePath,
    handoffPath: handoffRelativePath,
    ...(validationRelativePath ? { validationPath: validationRelativePath } : {}),
    proofArtifacts: handoffState.appProof?.artifacts ?? [],
    ...(previousFailure ? { previousFailure } : {})
  };
  const next = normalizeIssueState({
    ...(current ?? {
      schemaVersion: 1 as const,
      issueId: issue.id,
      issueIdentifier,
      updatedAt: recordedAt
    }),
    ...handoffState,
    ...prState,
    issueId: current?.issueId ?? issue.id,
    issueIdentifier,
    phase: "completed",
    lastRunId: acceptedRunId,
    workspacePath: workspaceRelativePath,
    workspaceKey: workspaceKey(issueIdentifier),
    headSha,
    validation: {
      ...validation.state,
      ...(validationRelativePath ? { path: validationRelativePath } : {})
    },
    operatorRecovery,
    ...clearedFailureMetadataPatch(),
    reviewStatus: handoffState.reviewStatus,
    reviewIteration: handoffState.reviewIteration,
    reviewers: undefined,
    findings: undefined,
    reviewRunnerFailures: undefined,
    reviewBudget: undefined,
    splitRecommendation: undefined,
    mergeCleanupWarnings: undefined,
    appProof: handoffState.appProof,
    updatedAt: recordedAt
  });
  await stateStore.write(next);
  await new RuntimeStateStore(repoRoot).clearIssue(next.issueId, issueIdentifier);
  return {
    issueIdentifier,
    branch,
    headSha,
    workspacePath: workspaceRelativePath,
    handoffPath: handoffRelativePath,
    validationPath: validationRelativePath ?? null,
    proofArtifacts: operatorRecovery.proofArtifacts,
    state: next
  };
}

export function formatOperatorRecoveryRecord(result: OperatorRecoveryRecordResult): string {
  return [
    `recorded: ${result.issueIdentifier}`,
    `branch: ${result.branch}`,
    `head: ${result.headSha}`,
    `workspace: ${result.workspacePath}`,
    `handoff: ${result.handoffPath}`,
    result.validationPath ? `validation: ${result.validationPath}` : null,
    result.proofArtifacts.length ? `proof: ${result.proofArtifacts.map((artifact) => `${artifact.label}=${artifact.value}`).join(", ")}` : "proof: none recorded"
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function formatRecoveryDiagnostics(diagnostics: WorkspaceRecoveryDiagnostics): string[] {
  return [
    `Workspace recovery: ${diagnostics.recoverable ? "recoverable partial work" : diagnostics.exists ? "workspace clean" : "workspace missing"}`,
    `Workspace: ${diagnostics.workspacePath}`,
    diagnostics.branch ? `Branch: ${diagnostics.branch}` : null,
    diagnostics.headSha ? `Local HEAD: ${diagnostics.headSha}` : null,
    diagnostics.reasons.length ? `Recovery reasons: ${diagnostics.reasons.join("; ")}` : null,
    `Next safe action: ${diagnostics.nextSafeAction}`
  ].filter((line): line is string => line !== null);
}

async function resolveRecoveryWorkspace(repoRoot: string, issueIdentifier: string, state: IssueState | null, explicitWorkspacePath?: string): Promise<string> {
  if (explicitWorkspacePath) return resolveFromRepo(repoRoot, explicitWorkspacePath);
  const defaultWorkspace = resolve(repoRoot, ".agent-os", "workspaces", workspaceKey(issueIdentifier));
  const stateWorkspace = state?.workspacePath ? resolveFromRepo(repoRoot, state.workspacePath) : null;
  const candidates = uniquePaths([stateWorkspace, defaultWorkspace]);
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) existing.push(candidate);
  }
  if (existing.length > 1) {
    throw new OperatorRecoveryRefusal(
      `multiple workspace candidates exist: ${existing.join(", ")}`,
      "rerun recovery with --workspace pointing at the clean worktree that owns the recovered handoff and validation evidence"
    );
  }
  return existing[0] ?? stateWorkspace ?? defaultWorkspace;
}

function assertRecoveryEvidenceCanBeRecorded(diagnostics: WorkspaceRecoveryDiagnostics | null, workspacePath: string): asserts diagnostics is WorkspaceRecoveryDiagnostics & { branch: string; headSha: string } {
  if (!diagnostics || !diagnostics.exists) {
    throw new OperatorRecoveryRefusal(
      `workspace evidence is missing at ${workspacePath}`,
      "restore the partial-work workspace, or pass --workspace pointing at the recovered clean worktree before recording recovery"
    );
  }
  if (!diagnostics.branch || diagnostics.branch === "HEAD") {
    throw new OperatorRecoveryRefusal(
      "worktree is detached or branch evidence is unavailable",
      "checkout the recovered branch in the worktree before recording recovery"
    );
  }
  if (!diagnostics.headSha) {
    throw new OperatorRecoveryRefusal(
      "worktree HEAD evidence is unavailable",
      "repair the git worktree so `git rev-parse HEAD` succeeds before recording recovery"
    );
  }
  if (diagnostics.dirty) {
    throw new OperatorRecoveryRefusal(
      "worktree has uncommitted changes",
      "commit or stash the recovered changes, rerun validation, and record recovery from a clean worktree"
    );
  }
  if (diagnostics.upstreamMissing) {
    throw new OperatorRecoveryRefusal(
      `branch ${diagnostics.branch} has no upstream`,
      `push ${diagnostics.branch} with an upstream, rerun validation if the head changes, and record recovery again`
    );
  }
  if (diagnostics.aheadCount > 0 && diagnostics.behindCount > 0) {
    throw new OperatorRecoveryRefusal(
      `branch ${diagnostics.branch} has diverged from upstream (${diagnostics.aheadCount} commit(s) ahead, ${diagnostics.behindCount} commit(s) behind)`,
      "reconcile the local and upstream branch heads, rerun validation on the final pushed head, and record recovery again"
    );
  }
  if (diagnostics.aheadCount > 0) {
    throw new OperatorRecoveryRefusal(
      `branch ${diagnostics.branch} is ${diagnostics.aheadCount} commit(s) ahead of upstream`,
      "push the recovered branch, confirm the pushed head matches validation evidence, and record recovery again"
    );
  }
  if (diagnostics.behindCount > 0) {
    throw new OperatorRecoveryRefusal(
      `branch ${diagnostics.branch} is ${diagnostics.behindCount} commit(s) behind upstream`,
      "pull or reset to the intended upstream head, rerun validation, and record recovery again"
    );
  }
}

function resolveRecoveryHandoff(repoRoot: string, workspacePath: string, issueIdentifier: string, explicitHandoffPath?: string): string {
  if (explicitHandoffPath) return resolveFromRepo(repoRoot, explicitHandoffPath);
  return join(workspacePath, ".agent-os", `handoff-${issueIdentifier}.md`);
}

function issueForRecovery(issueIdentifier: string, state: IssueState | null): Issue {
  return {
    id: state?.issueId || `issue-${issueIdentifier}`,
    identifier: issueIdentifier,
    title: issueIdentifier,
    description: null,
    priority: null,
    state: "",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null
  };
}

function resolveFromRepo(repoRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
}

function relativeToRepo(repoRoot: string, path: string): string {
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function uniquePaths(paths: Array<string | null>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)).map((path) => resolve(path)))];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}
