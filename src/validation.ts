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
  commands: ValidationCommandEvidence[];
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
  if (input.runId && evidence.runId !== input.runId) errors.push(`runId mismatch: expected ${input.runId}`);
  if (evidence.status !== "passed") errors.push("validation status is not passed");
  if (!Array.isArray(evidence.commands) || evidence.commands.length === 0) errors.push("commands must be a non-empty array");

  const expectedCommands = input.expectedCommands ?? defaultExpectedCommands;
  for (const expected of expectedCommands) {
    if (!evidence.commands?.some((command) => command.name === expected)) errors.push(`missing command evidence: ${expected}`);
  }

  const now = input.now ?? new Date();
  for (const command of evidence.commands ?? []) {
    if (typeof command.name !== "string" || !command.name.trim()) errors.push("command name is required");
    if (command.exitCode !== 0) errors.push(`${command.name}: exitCode ${command.exitCode}`);
    const started = parseTime(command.startedAt);
    const finished = parseTime(command.finishedAt);
    if (!started) errors.push(`${command.name}: invalid startedAt`);
    if (!finished) errors.push(`${command.name}: invalid finishedAt`);
    if (started && finished && started > finished) errors.push(`${command.name}: startedAt is after finishedAt`);
    if (finished && finished.getTime() - now.getTime() > maxFutureSkewMs) errors.push(`${command.name}: finishedAt is in the future`);
    if (finished && now.getTime() - finished.getTime() > maxEvidenceAgeMs) errors.push(`${command.name}: validation evidence is stale`);
  }

  const workspaceHead = await gitHead(input.workspacePath);
  if (workspaceHead && evidence.repoHead !== workspaceHead) errors.push(`repoHead mismatch: expected ${workspaceHead}`);

  return {
    state: {
      status: errors.length === 0 ? "passed" : "failed",
      path,
      errors: errors.length ? errors : undefined,
      checkedAt
    },
    evidence
  };
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
