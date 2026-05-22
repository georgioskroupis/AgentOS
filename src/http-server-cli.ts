import { resolveRepoEnv } from "./env.js";
import { startAgentOsHttpServer, type AgentOsHttpServerHandle } from "./http-server.js";
import { loadWorkflow, resolveServiceConfig } from "./workflow.js";

export async function startHttpServerIfConfigured(input: {
  repoRoot: string;
  workflowPath: string;
  port?: number;
  host?: string;
  onRefresh: () => Promise<void>;
}): Promise<AgentOsHttpServerHandle | null> {
  try {
    const resolvedEnv = await resolveRepoEnv(input.repoRoot, process.env);
    const workflow = await loadWorkflow(input.workflowPath);
    const config = resolveServiceConfig(workflow, resolvedEnv.env);
    const server = await startAgentOsHttpServer({
      repoRoot: input.repoRoot,
      config,
      port: input.port,
      host: input.host,
      onRefresh: input.onRefresh
    });
    if (server) console.error(`AgentOS HTTP API listening at ${server.url}`);
    return server;
  } catch (error) {
    console.error(`AgentOS HTTP API disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
