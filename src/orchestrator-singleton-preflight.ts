import type { DaemonPreflightResult, RepoEnvLoadResult } from "./env.js";
import type { JsonlLogger } from "./logging.js";
import { recordOrchestratorDaemonPreflightRuntime } from "./orchestrator-daemon-runtime.js";
import type { OrchestratorStartupPreflightResult } from "./orchestrator-startup-preflight.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import type { WorkflowDefinition } from "./types.js";

export async function recordSingletonPreflightFailure(input: {
  daemonStartedAt: string;
  workflow: WorkflowDefinition;
  preflight: DaemonPreflightResult | null;
  repoEnv: RepoEnvLoadResult | null;
  runtimeState: RuntimeStateStore;
  logger: JsonlLogger;
  startupPreflight: OrchestratorStartupPreflightResult | null;
}): Promise<boolean> {
  if (input.preflight?.status !== "singleton_conflict") return false;
  await recordOrchestratorDaemonPreflightRuntime({
    daemonStartedAt: input.daemonStartedAt,
    workflow: input.workflow,
    preflight: input.preflight,
    repoEnv: input.repoEnv,
    runtimeState: input.runtimeState
  });
  await input.logger.write({
    type: "daemon_preflight_failed",
    message: input.preflight.message,
    payload: {
      ...input.preflight,
      startupPreflight: input.startupPreflight
    }
  });
  return true;
}
