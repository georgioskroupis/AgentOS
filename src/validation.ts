import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { exists, readText } from "./fs-utils.js";
import type { Issue, ReviewFinding, ValidationState } from "./types.js";
import { findingHash } from "./review.js";

export interface ValidationEvidence {
  schemaVersion: 1;
  issueIdentifier: string;
  runId?: string;
  repoHead?: string;
  status: "passed" | "failed";
  finalResult?: ValidationFinalResultEvidence;
  commands: ValidationCommandEvidence[];
  githubCi?: ValidationState["githubCi"];
}

export interface ValidationFinalResultEvidence {
  status: "passed" | "failed";
  command?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface ValidationCommandEvidence {
  name: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
}

export interface ValidationEvidenceCheck {
  state: ValidationState;
  evidence?: ValidationEvidence;
}

const defaultExpectedCommands = ["npm run agent-check"];
const maxFutureSkewMs = 5 * 60 * 1000;
const maxEvidenceAgeMs = 24 * 60 * 60 * 1000;

export async function verifyValidationEvidence(input: {
  issue: Issue;
  handoff: string | null;
  workspacePath: string;
  runId?: string;
  selectedHeadSha?: string | null;
  allowReusableRunEvidence?: boolean;
  expectedCommands?: string[];
  now?: Date;
}): Promise<ValidationEvidenceCheck> {
  const checkedAt = new Date().toISOString();
  const errors: string[] = [];
  const marker = input.handoff ? validationEvidencePath(input.handoff) : null;
  if (!marker) {
    return { state: { status: "missing", errors: ["handoff missing Validation-JSON marker"], checkedAt } };
  }

  const path = resolve(input.workspacePath, marker);
  if (!path.startsWith(resolve(input.workspacePath))) {
    return { state: { status: "failed", path, errors: ["validation evidence path escapes workspace"], checkedAt } };
  }
  if (!(await exists(path))) {
    return { state: { status: "missing", path, errors: ["validation evidence file does not exist"], checkedAt } };
  }

  let evidence: ValidationEvidence | null = null;
  try {
    evidence = JSON.parse(await readText(path)) as ValidationEvidence;
  } catch (error) {
    return {
      state: {
        status: "failed",
        path,
        errors: [`validation evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
        checkedAt
      }
    };
  }

  if (evidence.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (evidence.issueIdentifier !== input.issue.identifier) errors.push(`issueIdentifier mismatch: expected ${input.issue.identifier}`);
  if (!Array.isArray(evidence.commands) || evidence.commands.length === 0) errors.push("commands must be a non-empty array");

  const now = input.now ?? new Date();
  const rawFinalStatus = evidence.finalResult?.status ?? evidence.status;
  const finalStatus = rawFinalStatus === "passed" || rawFinalStatus === "failed" ? rawFinalStatus : "failed";
  if (rawFinalStatus !== "passed" && rawFinalStatus !== "failed") errors.push("validation status must be passed or failed");
  if (finalStatus !== "passed") errors.push("final validation status is not passed");
  if (evidence.finalResult) validateFinalResult(evidence.finalResult, errors, now);
  if (evidence.githubCi) validateGithubCi(evidence.githubCi, errors);

  const expectedCommands = input.expectedCommands ?? defaultExpectedCommands;
  const acceptedCommands: ValidationCommandEvidence[] = [];
  const acceptedCommandSet = new Set<string>();
  const failedHistoricalAttempts: ValidationCommandEvidence[] = [];
  for (const expected of expectedCommands) {
    const accepted = evidence.commands?.filter((command) => isAcceptedCommand(command, expected, now)) ?? [];
    if (accepted.length === 0) errors.push(`missing passing command evidence: ${expected}`);
    acceptedCommands.push(...accepted);
    for (const command of accepted) {
      acceptedCommandSet.add(commandIdentity(command));
    }
  }

  const additionalPassingCommands: ValidationCommandEvidence[] = [];
  for (const command of evidence.commands ?? []) {
    if (typeof command.name !== "string" || !command.name.trim()) errors.push("command name is required");
    if (typeof command.exitCode !== "number" || !Number.isInteger(command.exitCode)) errors.push(`${command.name}: exitCode must be an integer`);
    else if (command.exitCode !== 0) failedHistoricalAttempts.push(command);
    else if (isAcceptedCommand(command, command.name, now) && !acceptedCommandSet.has(commandIdentity(command))) {
      additionalPassingCommands.push(command);
    }
    const started = parseTime(command.startedAt);
    const finished = parseTime(command.finishedAt);
    if (!started) errors.push(`${command.name}: invalid startedAt`);
    if (!finished) errors.push(`${command.name}: invalid finishedAt`);
    if (started && finished && started > finished) errors.push(`${command.name}: startedAt is after finishedAt`);
    if (finished && finished.getTime() - now.getTime() > maxFutureSkewMs) errors.push(`${command.name}: finishedAt is in the future`);
    if (finished && now.getTime() - finished.getTime() > maxEvidenceAgeMs) errors.push(`${command.name}: validation evidence is stale`);
  }

  const workspaceHead = await gitHead(input.workspacePath);
  const selectedHeadSha = input.selectedHeadSha ?? null;
  const reusableHead = workspaceHead ?? selectedHeadSha;
  if (input.runId && evidence.runId !== input.runId && !isReusableRunEvidence(evidence, input.runId, reusableHead, input.allowReusableRunEvidence === true)) {
    errors.push(`runId mismatch: expected ${input.runId}`);
  }
  if (workspaceHead && evidence.repoHead !== workspaceHead) errors.push(`repoHead mismatch: expected ${workspaceHead}`);

  return {
    state: {
      status: errors.length === 0 ? "passed" : "failed",
      path,
      ...(evidence.runId ? { runId: evidence.runId } : {}),
      repoHead: evidence.repoHead ?? null,
      finalStatus,
      acceptedCommands,
      additionalPassingCommands: additionalPassingCommands.length ? additionalPassingCommands : undefined,
      failedHistoricalAttempts,
      ...(evidence.githubCi ? { githubCi: evidence.githubCi } : {}),
      errors: errors.length ? errors : undefined,
      checkedAt
    },
    evidence
  };
}

function isReusableRunEvidence(evidence: ValidationEvidence, expectedRunId: string, expectedHeadSha: string | null, enabled: boolean): boolean {
  if (!enabled) return false;
  if (!evidence.runId || evidence.runId === expectedRunId) return false;
  if (!evidence.repoHead || !expectedHeadSha) return false;
  return sameSha(evidence.repoHead, expectedHeadSha);
}

function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function validationEvidenceFinding(validation: ValidationState | undefined): ReviewFinding | null {
  if (!validation || validation.status === "passed") return null;
  const body = validation.errors?.length
    ? `Validation evidence is ${validation.status}: ${validation.errors.join("; ")}`
    : `Validation evidence is ${validation.status}.`;
  const base = {
    reviewer: "validation",
    decision: "changes_requested" as const,
    severity: "P1" as const,
    file: validation.path ?? null,
    line: null,
    body
  };
  return { ...base, findingHash: findingHash(base) };
}

export async function writeValidationEvidence(path: string, evidence: ValidationEvidence): Promise<void> {
  const { writeTextEnsuringDir } = await import("./fs-utils.js");
  await writeTextEnsuringDir(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

export function validationEvidencePath(handoff: string): string | null {
  const match = handoff.match(/^Validation-JSON:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}

function parseTime(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isAcceptedCommand(command: ValidationCommandEvidence, expectedName: string, now: Date): boolean {
  if (command.name !== expectedName) return false;
  if (command.exitCode !== 0) return false;
  const started = parseTime(command.startedAt);
  const finished = parseTime(command.finishedAt);
  if (!started || !finished) return false;
  if (started > finished) return false;
  if (finished.getTime() - now.getTime() > maxFutureSkewMs) return false;
  if (now.getTime() - finished.getTime() > maxEvidenceAgeMs) return false;
  return true;
}

function commandIdentity(command: ValidationCommandEvidence): string {
  return `${command.name}\0${command.exitCode}\0${command.startedAt}\0${command.finishedAt}`;
}

function validateFinalResult(finalResult: ValidationFinalResultEvidence, errors: string[], now: Date): void {
  if (finalResult.status !== "passed" && finalResult.status !== "failed") {
    errors.push("finalResult.status must be passed or failed");
  }
  if (finalResult.exitCode != null && (!Number.isInteger(finalResult.exitCode) || finalResult.exitCode < 0)) {
    errors.push("finalResult.exitCode must be a non-negative integer");
  }
  if (finalResult.status === "passed" && finalResult.exitCode != null && finalResult.exitCode !== 0) {
    errors.push("finalResult exitCode must be 0 when finalResult.status is passed");
  }
  if (finalResult.startedAt && !parseTime(finalResult.startedAt)) errors.push("finalResult.startedAt is invalid");
  if (finalResult.finishedAt && !parseTime(finalResult.finishedAt)) errors.push("finalResult.finishedAt is invalid");
  const started = finalResult.startedAt ? parseTime(finalResult.startedAt) : null;
  const finished = finalResult.finishedAt ? parseTime(finalResult.finishedAt) : null;
  if (started && finished && started > finished) errors.push("finalResult.startedAt is after finalResult.finishedAt");
  if (finished && finished.getTime() - now.getTime() > maxFutureSkewMs) errors.push("finalResult.finishedAt is in the future");
  if (finished && now.getTime() - finished.getTime() > maxEvidenceAgeMs) errors.push("finalResult validation evidence is stale");
}

function validateGithubCi(ci: NonNullable<ValidationState["githubCi"]>, errors: string[]): void {
  if (ci.status !== "passed" && ci.status !== "failed" && ci.status !== "pending") {
    errors.push("githubCi.status must be passed, failed, or pending");
  }
  if (ci.headSha != null && typeof ci.headSha !== "string") errors.push("githubCi.headSha must be a string when present");
  if (ci.source != null && typeof ci.source !== "string") errors.push("githubCi.source must be a string when present");
  if (ci.checkedAt && !parseTime(ci.checkedAt)) errors.push("githubCi.checkedAt is invalid");
}

function gitHead(cwd: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => resolvePromise(code === 0 ? stdout.trim() || null : null));
  });
}
