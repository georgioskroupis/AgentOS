import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveRepoEnv } from "./env.js";
import { readText } from "./fs-utils.js";
import { LinearClient } from "./linear.js";
import { seedMaintenanceIssues } from "./maintenance.js";
import { loadWorkflow, resolveServiceConfig } from "./workflow.js";

export async function linearClientFromWorkflow(workflowPath: string): Promise<LinearClient> {
  const { config } = await workflowConfigFromRepoEnv(workflowPath);
  return new LinearClient(config.tracker);
}

export async function runMaintenanceSeedCommand(options: { team: string; project: string; state: string; workflow: string }): Promise<void> {
  const client = await linearClientFromWorkflow(options.workflow);
  const result = await seedMaintenanceIssues(client, {
    team: options.team,
    project: options.project,
    state: options.state
  });
  for (const issue of result.issues) {
    console.log(`created maintenance issue: ${issue.identifier} ${issue.title}`);
  }
}

export async function workflowConfigFromRepoEnv(workflowPath: string): Promise<{
  workflow: Awaited<ReturnType<typeof loadWorkflow>>;
  config: ReturnType<typeof resolveServiceConfig>;
}> {
  const resolvedWorkflowPath = resolve(workflowPath);
  const repoRoot = dirname(resolvedWorkflowPath);
  const resolvedEnv = await resolveRepoEnv(repoRoot, process.env);
  const workflow = await loadWorkflow(resolvedWorkflowPath);
  return { workflow, config: resolveServiceConfig(workflow, resolvedEnv.env) };
}

export function formatAgentLifecycleResult(result: { status: string; issueIdentifier: string; marker?: string }): string {
  return [`${result.status}: ${result.issueIdentifier}`, result.marker ? `marker: ${result.marker}` : null].filter(Boolean).join("\n");
}

export function formatAgentLifecycleJsonResult(result: {
  status: string;
  issueIdentifier: string;
  marker?: string;
  fallbackPath?: string;
  runId?: string;
  attempt?: number | null;
}): string {
  return JSON.stringify({
    schemaVersion: 1,
    status: result.status,
    issueIdentifier: result.issueIdentifier,
    ...(result.marker ? { marker: result.marker } : {}),
    ...(result.fallbackPath ? { fallbackPath: result.fallbackPath } : {}),
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.attempt != null ? { attempt: result.attempt } : {})
  });
}

type LifecycleCliAction = "comment" | "move" | "attach-pr" | "record-handoff";

export function lifecycleToolForAction(action: LifecycleCliAction, tool: string): string {
  const lifecycleToolIdentities: Record<LifecycleCliAction, string[]> = {
    comment: ["agent-os linear lifecycle comment", "scripts/agent-linear-comment.sh"],
    move: ["agent-os linear lifecycle move", "scripts/agent-linear-move.sh"],
    "attach-pr": ["agent-os linear lifecycle attach-pr", "scripts/agent-linear-pr.sh"],
    "record-handoff": ["agent-os linear lifecycle record-handoff", "scripts/agent-linear-handoff.sh"]
  };
  const normalizedTool = normalizeLifecycleToolIdentity(tool);
  const identity = lifecycleToolIdentities[action].find((candidate) => normalizeLifecycleToolIdentity(candidate) === normalizedTool);
  if (!identity) throw new Error(`lifecycle tool/action mismatch: ${action} cannot use ${tool}`);
  return identity;
}

function normalizeLifecycleToolIdentity(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

export async function agentLifecycleContextFromOptions(options: { repo: string; workflow: string }): Promise<{
  repoRoot: string;
  config: ReturnType<typeof resolveServiceConfig>;
  tracker: LinearClient;
}> {
  const repoRoot = resolve(options.repo);
  const workflowPath = await resolveRepoLocalWorkflowPath(repoRoot, options.workflow);
  const resolvedEnv = await resolveRepoEnv(repoRoot, process.env);
  const workflow = await loadWorkflow(workflowPath);
  const config = resolveServiceConfig(workflow, resolvedEnv.env);
  return { repoRoot, config, tracker: new LinearClient(config.tracker) };
}

export async function bodyFromArgsOrFile(body: string[] | undefined, file: string | undefined, repoRoot: string, label: string): Promise<string> {
  const text = file ? await readText(await resolveRepoLocalInputPath(repoRoot, file, `${label} file`)) : (body ?? []).join(" ");
  if (!text.trim()) throw new Error(`${label} is required; pass text or --file <path>`);
  return text;
}

export async function resolveRepoLocalInputPath(repoRoot: string, path: string, label: string): Promise<string> {
  return (await resolveRepoLocalInputPathInfo(repoRoot, path, label)).absolutePath;
}

export async function resolveRepoLocalInputPathInfo(
  repoRoot: string,
  path: string,
  label: string
): Promise<{ absolutePath: string; relativePath: string }> {
  if (isAbsolute(path)) {
    throw new Error(`${label} must be relative to the repository root`);
  }
  const root = resolve(repoRoot);
  const resolvedPath = resolve(root, path);
  const relativePath = relative(root, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} must stay within the repository root`);
  }
  const realRoot = await realpath(root);
  const realResolvedPath = await realpath(resolvedPath);
  const realRelativePath = relative(realRoot, realResolvedPath);
  if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
    throw new Error(`${label} must stay within the repository root`);
  }
  return { absolutePath: realResolvedPath, relativePath: realRelativePath.replace(/\\/g, "/") };
}

export async function resolveRepoLocalWorkflowPath(repoRoot: string, path: string): Promise<string> {
  if (isAbsolute(path)) {
    throw new Error("workflow path must be relative to the repository root");
  }
  return resolveRepoLocalInputPath(repoRoot, path, "workflow path");
}
