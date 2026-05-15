import { spawn } from "node:child_process";
import { join } from "node:path";
import { exists, readText } from "./fs-utils.js";
import type { RunSummary } from "./runs.js";
import type { RuntimeActiveRun } from "./runtime-state.js";
import type { Issue, IssueState, Workspace } from "./types.js";

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
