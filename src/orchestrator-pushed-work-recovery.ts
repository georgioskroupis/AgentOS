import { spawn } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readText, writeTextEnsuringDir } from "./fs-utils.js";
import { GitHubClient, type PullRequestStatus } from "./github.js";
import { extractOutcome, extractPullRequestRefs } from "./issue-state.js";
import { inspectWorkspaceRecovery, publishCleanNoUpstreamRecoveryBranch, recordOperatorRecovery, type WorkspaceRecoveryDiagnostics } from "./recovery.js";
import { finalizeTrustedRecoveryValidationEvidence } from "./recovery-validation-finalization.js";
import { compactProcessDiagnostic } from "./process-diagnostics.js";
import { validationEvidencePath, verifyValidationEvidence, writeValidationEvidence, type ValidationCommandEvidence } from "./validation.js";
import { validationReuseProfileForConfig } from "./validation-profile.js";
import { workspaceKey } from "./workspace.js";
import type { JsonlLogger } from "./logging.js";
import type { AgentEvent, AgentRunResult, Issue, IssueState, ServiceConfig, Workspace } from "./types.js";

export interface AutoRecoverPushedWorkInput {
  issue: Issue;
  recovery: WorkspaceRecoveryDiagnostics;
  reason: string;
  repoRoot: string;
  config: ServiceConfig;
  runId?: string | null;
  logger: JsonlLogger;
  markRunningActivity?: (issueId: string, timestamp?: string) => void;
  markSucceeded: (workspace: Workspace, handoff: string | null, state: IssueState) => Promise<void>;
}

export interface PublishCleanRecoveryBranchInput {
  issue: Issue;
  recovery: WorkspaceRecoveryDiagnostics;
  state?: IssueState | null;
  repoRoot: string;
  logger: JsonlLogger;
}

export interface FinalizeCleanPushedWorkAfterRunnerStopInput {
  issue: Issue;
  workspace: Workspace;
  result: AgentRunResult;
  runId: string;
  state: IssueState | null;
  repoRoot: string;
  config: ServiceConfig;
  logger: JsonlLogger;
  markRunningActivity?: (issueId: string, timestamp?: string) => void;
  markSucceeded: (workspace: Workspace, handoff: string | null, state: IssueState) => Promise<void>;
  writeRunHandoff: (handoff: string) => Promise<void>;
  writeRunEvent: (entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }) => Promise<void>;
  completeRun: (result: AgentRunResult) => Promise<void>;
}

export async function publishCleanRecoveryBranchIfSafe(input: PublishCleanRecoveryBranchInput): Promise<WorkspaceRecoveryDiagnostics> {
  const { issue, recovery } = input;
  if (!recovery.cleanUnpushedWork) return recovery;
  try {
    const pushed = await publishCleanNoUpstreamRecoveryBranch(issue.identifier, recovery);
    if (!pushed) return recovery;
    const refreshed = await inspectWorkspaceRecovery(resolve(input.repoRoot), {
      issueIdentifier: issue.identifier,
      workspacePath: recovery.workspacePath,
      headSha: input.state?.headSha ?? null,
      validation: input.state?.validation
    }).catch(() => null);
    await input.logger.write({
      type: "recovery_branch_pushed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: "published clean local recovery branch before recovery reconciliation",
      payload: { branch: recovery.branch, headSha: recovery.headSha, workspacePath: recovery.workspacePath }
    });
    return refreshed ?? recovery;
  } catch (error) {
    await input.logger.write({
      type: "recovery_branch_push_failed",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: error instanceof Error ? error.message : String(error),
      payload: { branch: recovery.branch, headSha: recovery.headSha, workspacePath: recovery.workspacePath }
    });
    return recovery;
  }
}

export async function finalizeCleanPushedWorkAfterRunnerStop(input: FinalizeCleanPushedWorkAfterRunnerStopInput): Promise<boolean> {
  if (!isRunnerClosureResult(input.result)) return false;
  let recovery = await inspectWorkspaceRecovery(resolve(input.repoRoot), {
    issueIdentifier: input.issue.identifier,
    workspacePath: input.workspace.path,
    headSha: input.state?.headSha ?? null,
    validation: input.state?.validation
  }).catch(() => null);
  if (!recovery?.recoverable) return false;
  recovery = await publishCleanRecoveryBranchIfSafe({ issue: input.issue, recovery, state: input.state, repoRoot: input.repoRoot, logger: input.logger });
  const recovered = await autoRecoverPushedWork({
    issue: input.issue,
    recovery,
    reason: `implementation runner stopped after clean pushed work was produced: ${input.result.error ?? input.result.status}`,
    repoRoot: input.repoRoot,
    config: input.config,
    runId: input.runId,
    logger: input.logger,
    markRunningActivity: input.markRunningActivity,
    markSucceeded: input.markSucceeded
  });
  if (!recovered) return false;

  const handoff = await readText(join(recovery.workspacePath, ".agent-os", `handoff-${input.issue.identifier}.md`)).catch(() => null);
  if (handoff) await input.writeRunHandoff(handoff);
  const recoveredResult: AgentRunResult = { ...input.result, status: "succeeded", error: undefined };
  await input.writeRunEvent({
    type: "run_succeeded",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: "completed after clean pushed work recovery",
    payload: { ...recoveredResult, recoveredFrom: input.result.status, originalError: input.result.error }
  });
  await input.completeRun(recoveredResult);
  return true;
}

export async function autoRecoverPushedWork(input: AutoRecoverPushedWorkInput): Promise<boolean> {
  const { issue, recovery } = input;
  if (!recovery.exists || !recovery.branch || !recovery.headSha || !recovery.cleanPushedWork) return false;
  if (recovery.branch !== `agent/${issue.identifier}`) return false;

  const repoRoot = resolve(input.repoRoot);
  const handoffPath = join(recovery.workspacePath, ".agent-os", `handoff-${issue.identifier}.md`);
  const finalized = await finalizeCleanPushedWorkEvidence(input, handoffPath);
  if (!finalized) return false;

  try {
    const result = await recordOperatorRecovery({
      repoRoot,
      issueIdentifier: issue.identifier,
      workspacePath: recovery.workspacePath,
      ...(input.runId ? { runId: input.runId } : {})
    });
    const handoff = await readText(resolve(repoRoot, result.handoffPath)).catch(() => null);
    await input.markSucceeded({ path: result.workspacePath, workspaceKey: workspaceKey(issue.identifier), createdNow: false }, handoff, result.state);
    await input.logger.write({
      type: "pushed_work_recovered",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: input.reason,
      payload: {
        branch: result.branch,
        headSha: result.headSha,
        handoffPath: result.handoffPath,
        validationPath: result.validationPath,
        prs: result.state.prs ?? []
      }
    });
    return true;
  } catch (error) {
    await input.logger.write({
      type: "pushed_work_recovery_skipped",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: error instanceof Error ? error.message : String(error),
      payload: { branch: recovery.branch, headSha: recovery.headSha }
    });
    return false;
  }
}

async function finalizeCleanPushedWorkEvidence(input: AutoRecoverPushedWorkInput, handoffPath: string): Promise<boolean> {
  const { issue, recovery } = input;
  const repoRoot = resolve(input.repoRoot);
  const headSha = recovery.headSha;
  if (!headSha || !recovery.branch) return false;

  const handoffBefore = (await readText(handoffPath).catch(() => null)) ?? null;
  const handoffPrs = handoffBefore ? extractPullRequestRefs(handoffBefore) : [];
  if (handoffPrs.length > 1) {
    await logPushedWorkRecoverySkipped(input, "handoff pull request evidence is ambiguous", { prs: handoffPrs });
    return false;
  }

  const handoffPrUrl = handoffPrs[0]?.url ?? null;
  const pullRequest = handoffPrUrl ? await recoveryPullRequestFromHandoff(input, handoffPrUrl) : await recoveryPullRequestForBranch(input.config.github.command, repoRoot, recovery).catch(() => null);
  if (handoffPrUrl && !pullRequest) return false;
  if (pullRequest && !pullRequestHeadMatches(pullRequest, headSha)) {
    await logPushedWorkRecoverySkipped(input, "pull request head did not match clean pushed branch head", {
      branch: recovery.branch,
      headSha,
      prUrl: pullRequest.url,
      prHeadSha: pullRequest.headSha
    });
    return false;
  }

  const prUrl = pullRequest?.url ?? (await createRecoveryPullRequest(input, handoffPath).catch(async (error: Error) => {
    await logPushedWorkRecoverySkipped(input, `pull request creation failed: ${error.message}`, { branch: recovery.branch, headSha });
    return null;
  }));
  if (!prUrl) return false;

  const createdPullRequest = pullRequest ? pullRequest : await verifiedRecoveryPullRequest(input, prUrl).catch(() => null);
  if (createdPullRequest && !pullRequestHeadMatches(createdPullRequest, headSha)) {
    await logPushedWorkRecoverySkipped(input, "created pull request head did not match clean pushed branch head", {
      branch: recovery.branch,
      headSha,
      prUrl,
      prHeadSha: createdPullRequest.headSha
    });
    return false;
  }

  await repairRecoveryHandoff(handoffPath, issue.identifier, prUrl);
  const handoff = await readText(handoffPath);
  const validation = await verifyValidationEvidence({
    issue,
    handoff,
    workspacePath: recovery.workspacePath,
    ...(input.runId ? { runId: input.runId } : {}),
    allowReusableRunEvidence: true,
    validationBudget: input.config.validationBudget,
    reuseProfile: validationReuseProfileForConfig(input.config)
  });
  if (validation.state.status === "passed") {
    const finalized = await finalizeTrustedRecoveryValidationEvidence({
      evidence: validation.evidence,
      path: validation.state.path,
      issueIdentifier: issue.identifier,
      branch: recovery.branch,
      headSha,
      runId: input.runId ?? null,
      reuseProfile: validationReuseProfileForConfig(input.config),
      fullValidationCommand: input.config.validationBudget.fullValidationCommand
    });
    if (!finalized) {
      await logPushedWorkRecoverySkipped(input, "trusted validation evidence could not be finalized for clean pushed recovery", {
        branch: recovery.branch,
        headSha,
        validationPath: validation.state.path ?? null
      });
      return false;
    }
    await input.logger.write({
      type: "recovery_validation_finalized",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      message: "finalized trusted recovery validation evidence",
      payload: { branch: recovery.branch, headSha, validationPath: validation.state.path }
    });
    return true;
  }

  const rerun = await runRecoveryValidation({
    command: input.config.validationBudget.fullValidationCommand,
    cwd: recovery.workspacePath,
    timeoutMs: input.config.codex.turnTimeoutMs,
    issue,
    logger: input.logger,
    markRunningActivity: input.markRunningActivity,
    workspacePath: recovery.workspacePath,
    headSha
  });
  if (!rerun.started) {
    const validationProcess = compactProcessDiagnostic({
      pid: rerun.lock?.pid ?? null,
      status: rerun.lock ? "running" : "unknown",
      command: rerun.lock?.command ?? input.config.validationBudget.fullValidationCommand
    });
    await logPushedWorkRecoverySkipped(input, rerun.message, {
      validationProcess,
      headSha,
      lock: rerun.lock ? compactRecoveryValidationLock(rerun.lock) : null
    });
    return false;
  }
  const refreshed = await inspectWorkspaceRecovery(repoRoot, {
    issueIdentifier: issue.identifier,
    workspacePath: recovery.workspacePath,
    headSha
  }).catch(() => null);
  if (!refreshed?.cleanPushedWork || refreshed.headSha?.toLowerCase() !== headSha.toLowerCase()) {
    await logPushedWorkRecoverySkipped(input, "validation changed the recovery workspace head or branch state", {
      beforeHeadSha: headSha,
      afterHeadSha: refreshed?.headSha ?? null,
      reasons: refreshed?.reasons ?? []
    });
    return false;
  }

  const validationPath = resolve(recovery.workspacePath, validationEvidencePath(handoff) ?? `.agent-os/validation/${issue.identifier}.json`);
  if (!validationPath.startsWith(resolve(recovery.workspacePath))) {
    await logPushedWorkRecoverySkipped(input, "validation evidence path escapes recovery workspace", { validationPath });
    return false;
  }
  await writeValidationEvidence(validationPath, {
    schemaVersion: 1,
    issueIdentifier: issue.identifier,
    runId: input.runId ?? `recovery_${issue.identifier}`,
    repoHead: headSha,
    reuseProfile: validationReuseProfileForConfig(input.config),
    status: rerun.exitCode === 0 ? "passed" : "failed",
    finalResult: {
      status: rerun.exitCode === 0 ? "passed" : "failed",
      command: input.config.validationBudget.fullValidationCommand,
      exitCode: rerun.exitCode,
      startedAt: rerun.startedAt,
      finishedAt: rerun.finishedAt
    },
    commands: [rerun]
  });
  if (rerun.exitCode !== 0) {
    await logPushedWorkRecoverySkipped(input, "validation command failed for clean pushed recovery finalization", {
      command: input.config.validationBudget.fullValidationCommand,
      exitCode: rerun.exitCode
    });
    return false;
  }
  return true;
}

async function recoveryPullRequestForBranch(githubCommand: string, repoRoot: string, recovery: WorkspaceRecoveryDiagnostics): Promise<PullRequestStatus | null> {
  if (!recovery.branch) return null;
  const github = new GitHubClient(githubCommand);
  const pr = await github.getPullRequest(recovery.branch, repoRoot);
  return pr.state && pr.state.toUpperCase() !== "CLOSED" ? pr : null;
}

async function verifiedRecoveryPullRequest(input: AutoRecoverPushedWorkInput, url: string): Promise<PullRequestStatus | null> {
  const pr = await new GitHubClient(input.config.github.command).getPullRequest(url, resolve(input.repoRoot));
  return pr.state && pr.state.toUpperCase() !== "CLOSED" ? pr : null;
}

async function recoveryPullRequestFromHandoff(input: AutoRecoverPushedWorkInput, url: string): Promise<PullRequestStatus | null> {
  try {
    return await verifiedRecoveryPullRequest(input, url);
  } catch (error) {
    await logPushedWorkRecoverySkipped(input, "handoff pull request could not be verified", {
      prUrl: url,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function pullRequestHeadMatches(pullRequest: PullRequestStatus, expectedHeadSha: string): boolean {
  return Boolean(pullRequest.headSha && pullRequest.headSha.toLowerCase() === expectedHeadSha.toLowerCase());
}

async function createRecoveryPullRequest(input: AutoRecoverPushedWorkInput, handoffPath: string): Promise<string | null> {
  const { issue, recovery } = input;
  if (!recovery.branch) return null;
  const bodyPath = join(recovery.workspacePath, ".agent-os", `recovery-pr-${issue.identifier}.md`);
  await writeTextEnsuringDir(
    bodyPath,
    [
      `Recovery finalization for ${issue.identifier}.`,
      "",
      "AgentOS reconstructed this pull request from a clean pushed branch after Codex App Server closed before durable handoff evidence was complete.",
      "",
      `Handoff: ${handoffPath}`
    ].join("\n")
  );
  const raw = await runShell(
    `${input.config.github.command} pr create --title ${shellQuote(`${issue.identifier}: ${issue.title}`)} --body-file ${shellQuote(bodyPath)} --base ${shellQuote(input.config.github.baseBranch)} --head ${shellQuote(recovery.branch)} --draft`,
    recovery.workspacePath
  );
  return raw.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/)?.[0] ?? raw.trim().split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
}

async function repairRecoveryHandoff(handoffPath: string, issueIdentifier: string, pullRequestUrl: string): Promise<void> {
  const existing = (await readText(handoffPath).catch(() => "")) ?? "";
  const lines: string[] = [];
  if (!extractOutcome(existing)) lines.push("AgentOS-Outcome: implemented");
  lines.push(...existing.trimEnd().split(/\r?\n/).filter((line) => line.length > 0));
  if (!validationEvidencePath(lines.join("\n"))) lines.push(`Validation-JSON: .agent-os/validation/${issueIdentifier}.json`);
  if (extractPullRequestRefs(lines.join("\n")).length === 0) lines.push(`Primary PR: ${pullRequestUrl}`);
  if (!lines.some((line) => /^Recovery-Summary:/i.test(line))) {
    lines.push("Recovery-Summary: reconstructed after Codex app-server/session closure from a clean pushed branch and validation evidence.");
  }
  await writeTextEnsuringDir(handoffPath, `${lines.join("\n")}\n`);
}

async function runRecoveryValidation(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  issue: Issue;
  logger: JsonlLogger;
  markRunningActivity?: (issueId: string, timestamp?: string) => void;
  workspacePath: string;
  headSha: string;
}): Promise<RecoveryValidationRunResult> {
  const lock = await acquireRecoveryValidationLock(input);
  if (!lock.acquired) return { started: false, message: lock.message, lock: lock.lock };
  const startedAt = new Date().toISOString();
  const heartbeatWrites: Array<Promise<unknown>> = [];
  try {
    const result = await runShellExitCode({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      onStart: async (pid) => {
        lock.metadata.pid = pid ?? null;
        await writeRecoveryValidationLock(lock.path, { ...lock.metadata, pid: pid ?? null });
      },
      onHeartbeat: (elapsedMs) => {
        const timestamp = new Date().toISOString();
        input.markRunningActivity?.(input.issue.id, timestamp);
        heartbeatWrites.push(input.logger.write({
          type: "recovery_validation_heartbeat",
          issueId: input.issue.id,
          issueIdentifier: input.issue.identifier,
          message: "recovery validation still running",
          payload: {
            validationProcess: compactProcessDiagnostic({ pid: lock.metadata.pid, status: "running", command: input.command }),
            elapsedMs,
            timeoutMs: input.timeoutMs
          }
        }));
      }
    });
    await Promise.allSettled(heartbeatWrites);
    const finishedAt = new Date().toISOString();
    if (result.timedOut) {
      await input.logger.write({
        type: "recovery_validation_timeout",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        message: "recovery validation timed out",
        payload: {
          validationProcess: compactProcessDiagnostic({ pid: lock.metadata.pid, status: "timeout", command: input.command }),
          timeoutMs: input.timeoutMs
        }
      });
    }
    return { started: true, name: input.command, exitCode: result.exitCode, startedAt, finishedAt };
  } finally {
    await rm(lock.path, { force: true }).catch(() => undefined);
  }
}

function runShellExitCode(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  onStart?: (pid: number | undefined) => Promise<void> | void;
  onHeartbeat: (elapsedMs: number) => void;
}): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolveExitCode) => {
    const startedAt = Date.now();
    const child = spawn("bash", ["-lc", input.command], {
      cwd: input.cwd,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"]
    });
    Promise.resolve(input.onStart?.(child.pid)).catch(() => undefined);
    let timedOut = false;
    let settled = false;
    const heartbeat = setInterval(() => {
      input.onHeartbeat(Date.now() - startedAt);
    }, recoveryValidationHeartbeatMs(input.timeoutMs));
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child.pid, "SIGTERM");
      setTimeout(() => {
        if (!settled) terminateProcessGroup(child.pid, "SIGKILL");
      }, 1000).unref();
    }, input.timeoutMs);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolveExitCode({ exitCode: 1, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolveExitCode({ exitCode: code ?? (timedOut ? 124 : 1), timedOut });
    });
  });
}

function recoveryValidationHeartbeatMs(timeoutMs: number): number {
  if (timeoutMs < 1000) return Math.max(10, Math.floor(timeoutMs / 3));
  return Math.min(30_000, Math.max(1000, Math.floor(timeoutMs / 4)));
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

type RecoveryValidationLockMetadata = {
  issueIdentifier: string;
  workspacePath: string;
  headSha: string;
  command: string;
  pid: number | null;
  startedAt: string;
};

type RecoveryValidationRunResult =
  | ({ started: true } & ValidationCommandEvidence)
  | { started: false; message: string; lock?: RecoveryValidationLockMetadata | null };

type RecoveryValidationLock =
  | { acquired: true; path: string; metadata: RecoveryValidationLockMetadata }
  | { acquired: false; message: string; lock?: RecoveryValidationLockMetadata | null };

function compactRecoveryValidationLock(lock: RecoveryValidationLockMetadata): Omit<RecoveryValidationLockMetadata, "workspacePath" | "command"> & {
  validationProcess: ReturnType<typeof compactProcessDiagnostic>;
} {
  return {
    issueIdentifier: lock.issueIdentifier,
    headSha: lock.headSha,
    pid: lock.pid,
    startedAt: lock.startedAt,
    validationProcess: compactProcessDiagnostic({ pid: lock.pid, status: "running", command: lock.command })
  };
}

async function acquireRecoveryValidationLock(input: { issue: Issue; workspacePath: string; headSha: string; command: string }): Promise<RecoveryValidationLock> {
  const lockPath = recoveryValidationLockPath(input.workspacePath, input.issue.identifier);
  await mkdir(join(input.workspacePath, ".agent-os", "recovery-validation"), { recursive: true });
  const metadata: RecoveryValidationLockMetadata = {
    issueIdentifier: input.issue.identifier,
    workspacePath: resolve(input.workspacePath),
    headSha: input.headSha,
    command: input.command,
    pid: null,
    startedAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(lockPath, "wx");
      await fileHandle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
      return { acquired: true, path: lockPath, metadata };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      const existing = await readRecoveryValidationLock(lockPath);
      if (isActiveRecoveryValidationLock(existing)) {
        const sameWorkspace = existing.workspacePath === metadata.workspacePath;
        const sameHead = existing.headSha.toLowerCase() === metadata.headSha.toLowerCase();
        const message =
          sameWorkspace && sameHead
            ? "active recovery validation already running for this issue workspace and head"
            : "active recovery validation already running for this issue workspace";
        return { acquired: false, message, lock: existing };
      }
      await rm(lockPath, { force: true }).catch(() => undefined);
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  }

  return { acquired: false, message: "recovery validation lock could not be acquired", lock: await readRecoveryValidationLock(lockPath) };
}

async function writeRecoveryValidationLock(lockPath: string, metadata: RecoveryValidationLockMetadata): Promise<void> {
  await writeTextEnsuringDir(lockPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

async function readRecoveryValidationLock(lockPath: string): Promise<RecoveryValidationLockMetadata | null> {
  const text = await readText(lockPath).catch(() => null);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<RecoveryValidationLockMetadata>;
    if (!parsed.issueIdentifier || !parsed.workspacePath || !parsed.headSha || typeof parsed.command !== "string") return null;
    return {
      issueIdentifier: parsed.issueIdentifier,
      workspacePath: resolve(parsed.workspacePath),
      headSha: parsed.headSha,
      command: parsed.command,
      pid: typeof parsed.pid === "number" ? parsed.pid : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : ""
    };
  } catch {
    return null;
  }
}

function isActiveRecoveryValidationLock(lock: RecoveryValidationLockMetadata | null): lock is RecoveryValidationLockMetadata {
  if (!lock) return false;
  if (lock.pid) return isProcessAlive(lock.pid);
  const startedAtMs = Date.parse(lock.startedAt);
  return Number.isFinite(startedAtMs) && Date.now() - startedAtMs < 30_000;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function recoveryValidationLockPath(workspacePath: string, issueIdentifier: string): string {
  return join(workspacePath, ".agent-os", "recovery-validation", `${issueIdentifier}.json`);
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function runShell(command: string, cwd: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new Error(stderr.trim() || `command_failed: ${command}`));
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRunnerClosureResult(result: AgentRunResult): boolean {
  if (result.status === "canceled" || result.status === "stale") return true;
  const normalized = (result.error ?? "").toLowerCase();
  return normalized.includes("codex_app_server_closed") || normalized.includes("stream disconnected") || normalized.includes("canceled");
}

async function logPushedWorkRecoverySkipped(input: AutoRecoverPushedWorkInput, message: string, payload: Record<string, unknown>): Promise<void> {
  await input.logger.write({
    type: "pushed_work_recovery_skipped",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message,
    payload
  });
}
