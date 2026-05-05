import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { normalizeIssueState } from "./issue-state.js";
import { JsonlLogger } from "./logging.js";
import type { ValidationCommandState, ValidationState } from "./types.js";

export async function getStatus(repo = process.cwd(), limit = 20): Promise<string> {
  const logger = new JsonlLogger(resolve(repo));
  const entries = await logger.tail(limit);
  if (entries.length === 0) {
    return "No AgentOS run events recorded.";
  }
  return entries
    .map((entry) => {
      const issue = entry.issueIdentifier ? ` ${entry.issueIdentifier}` : "";
      const message = entry.message ? ` - ${entry.message}` : "";
      return `${entry.timestamp} ${entry.type}${issue}${message}`;
    })
    .join("\n");
}

export async function inspectIssue(repo = process.cwd(), identifier: string, limit = 30): Promise<string> {
  const root = resolve(repo);
  const statePath = join(root, ".agent-os", "state", "issues", `${safeFileName(identifier)}.json`);
  const logger = new JsonlLogger(root);
  const entries = (await logger.tail(500))
    .filter((entry) => entry.issueIdentifier?.toLowerCase() === identifier.toLowerCase())
    .slice(-limit);
  const state = (await exists(statePath)) ? normalizeIssueState(JSON.parse(await readText(statePath))) : null;
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
    state?.mergeTargetUrl ? `Merge target: ${state.mergeTargetUrl}${state.mergeTargetRole ? ` (${state.mergeTargetRole})` : ""}` : null,
    state?.mergeCleanupWarnings?.length ? `Merge cleanup warnings:\n${state.mergeCleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : null,
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
    validation.failedHistoricalAttempts?.length ? `Failed historical attempts:\n${commandLines(validation.failedHistoricalAttempts)}` : null,
    validation.errors?.length ? `Validation errors:\n${validation.errors.map((error) => `- ${error}`).join("\n")}` : null
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function commandLines(commands: ValidationCommandState[]): string {
  return commands
    .map((command) => `- ${command.name}: exitCode ${command.exitCode}, finished ${command.finishedAt}`)
    .join("\n");
}
