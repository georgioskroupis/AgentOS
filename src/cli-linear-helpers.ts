import { dirname, resolve } from "node:path";
import { resolveRepoEnv } from "./env.js";
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
