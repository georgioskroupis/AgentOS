import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { IssueState } from "./types.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceRecoveryDiagnostics {
  workspacePath: string;
  exists: boolean;
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  upstreamMissing: boolean;
  aheadCount: number;
  stalePrHead: boolean;
  staleCiHead: boolean;
  recoverable: boolean;
  reasons: string[];
  nextSafeAction: string;
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
  const aheadRaw = upstreamSha ? await gitOutput(workspacePath, ["rev-list", "--count", "@{u}..HEAD"]) : null;
  const dirty = Boolean(status?.trim());
  const upstreamMissing = Boolean(branch && branch !== "HEAD" && !upstreamSha);
  const aheadCount = Number.parseInt(aheadRaw ?? "0", 10) || 0;
  const stalePrHead = Boolean(issue.headSha && headSha && issue.headSha !== headSha);
  const ciHeadSha = issue.validation?.githubCi?.headSha ?? null;
  const staleCiHead = Boolean(ciHeadSha && headSha && ciHeadSha !== headSha);
  const reasons = [
    dirty ? "workspace has uncommitted changes" : null,
    upstreamMissing ? "branch has no upstream" : null,
    aheadCount > 0 ? `branch is ${aheadCount} commit(s) ahead of upstream` : null,
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
    stalePrHead,
    staleCiHead,
    recoverable,
    reasons,
    nextSafeAction: recoverable
      ? `resume ${workspacePath}, preserve existing changes, run validation, then commit and push the existing branch before updating the handoff or PR`
      : `reuse ${workspacePath} for any follow-up; rerun validation before changing Linear state`
  };
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
