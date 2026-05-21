import { resolve } from "node:path";
import { initialDaemonFreshnessState, refreshDaemonFreshness, type DaemonFreshnessState } from "./daemon-freshness.js";
import { writeDaemonIdentity } from "./daemon-identity.js";
import type { DaemonPreflightResult, RepoEnvLoadResult } from "./env.js";
import type { JsonlLogger } from "./logging.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import type { ServiceConfig, WorkflowDefinition } from "./types.js";

export interface OrchestratorDaemonRuntimeState {
  daemonFreshness: DaemonFreshnessState;
  freshnessWarningMarker: string | null;
  preflightWarningMarker: string | null;
}

export interface RefreshOrchestratorDaemonRuntimeOptions extends OrchestratorDaemonRuntimeState {
  repoRoot: string;
  workflow: WorkflowDefinition;
  config: ServiceConfig;
  daemonStartedAt: string;
  preflight: DaemonPreflightResult | null;
  repoEnv: RepoEnvLoadResult | null;
  runtimeState: RuntimeStateStore;
  logger: JsonlLogger;
  preflightWarningMarker: string | null;
  forceMainRefresh?: boolean;
}

export async function refreshOrchestratorDaemonRuntime(
  options: RefreshOrchestratorDaemonRuntimeOptions
): Promise<OrchestratorDaemonRuntimeState> {
  const repoRoot = resolve(options.repoRoot);
  const freshness = await refreshDaemonFreshness({
    state: options.daemonFreshness,
    repoRoot,
    mainBranch: options.config.github.baseBranch,
    refreshIntervalTicks: options.config.daemon.mainBranchRefreshIntervalTicks,
    forceMainRefresh: options.forceMainRefresh
  });
  await writeDaemonIdentity(repoRoot, { startedAt: options.daemonStartedAt, startGitSha: freshness.startGitSha });
  await options.runtimeState.setDaemon({
    startedAt: options.daemonStartedAt,
    startGitSha: freshness.startGitSha,
    startMainGitSha: freshness.startMainGitSha,
    currentGitSha: freshness.currentGitSha,
    currentMainGitSha: freshness.currentMainGitSha,
    workflowPath: options.workflow.workflowPath,
    freshnessStatus: freshness.freshnessStatus,
    freshnessMessage: freshness.freshnessMessage,
    preflightStatus: options.preflight?.status,
    preflightMessage: options.preflight?.message ?? null,
    repoEnvPath: options.preflight?.repoEnvPath ?? options.repoEnv?.path ?? null,
    repoEnvStatus: options.preflight?.repoEnvStatus ?? options.repoEnv?.status,
    credentialPreflight: options.preflight ?? undefined
  });

  let freshnessWarningMarker = options.freshnessWarningMarker;
  if (freshness.freshnessMessage && freshnessWarningMarker !== freshness.freshnessMessage) {
    freshnessWarningMarker = freshness.freshnessMessage;
    await options.logger.write({
      type: "daemon_freshness_warning",
      message: freshness.freshnessMessage,
      payload: {
        daemonStartedAt: options.daemonStartedAt,
        workflowPath: options.workflow.workflowPath,
        startGitSha: freshness.startGitSha,
        startMainGitSha: freshness.startMainGitSha,
        currentGitSha: freshness.currentGitSha,
        currentMainGitSha: freshness.currentMainGitSha
      }
    });
  }
  let preflightWarningMarker = options.preflightWarningMarker;
  if (options.preflight && options.preflight.status !== "ready" && preflightWarningMarker !== options.preflight.message) {
    preflightWarningMarker = options.preflight.message;
    await options.logger.write({
      type: "daemon_preflight_warning",
      message: options.preflight.message,
      payload: options.preflight
    });
  }
  return { daemonFreshness: freshness, freshnessWarningMarker, preflightWarningMarker };
}

export async function recordOrchestratorDaemonPreflightRuntime(options: {
  daemonStartedAt: string;
  workflow: WorkflowDefinition;
  preflight: DaemonPreflightResult | null;
  repoEnv: RepoEnvLoadResult | null;
  runtimeState: RuntimeStateStore;
}): Promise<void> {
  await options.runtimeState.setDaemon({
    startedAt: options.daemonStartedAt,
    workflowPath: options.workflow.workflowPath,
    preflightStatus: options.preflight?.status,
    preflightMessage: options.preflight?.message ?? null,
    repoEnvPath: options.preflight?.repoEnvPath ?? options.repoEnv?.path ?? null,
    repoEnvStatus: options.preflight?.repoEnvStatus ?? options.repoEnv?.status,
    credentialPreflight: options.preflight ?? undefined
  });
}

export function initialOrchestratorDaemonRuntimeState(): OrchestratorDaemonRuntimeState {
  return { daemonFreshness: initialDaemonFreshnessState(), freshnessWarningMarker: null, preflightWarningMarker: null };
}
