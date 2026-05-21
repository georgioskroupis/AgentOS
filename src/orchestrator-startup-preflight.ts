import { evaluateDaemonSingletonGuard, type DaemonSingletonGuardResult, type ReadDaemonIdentityOptions } from "./daemon-identity.js";
import { preflightAllowsDispatch, type DaemonPreflightResult } from "./env.js";

export type OrchestratorStartupPreflightDecision = "allow" | "refuse";

export interface OrchestratorStartupPreflightResult {
  decision: OrchestratorStartupPreflightDecision;
  allowed: boolean;
  message: string;
  daemonPreflight: DaemonPreflightResult;
  singletonGuard: DaemonSingletonGuardResult;
}

export interface EvaluateOrchestratorStartupPreflightOptions {
  repoRoot: string;
  daemonPreflight: DaemonPreflightResult;
  singletonGuardOptions?: ReadDaemonIdentityOptions;
  currentPid?: number;
}

export async function evaluateOrchestratorStartupPreflight(
  options: EvaluateOrchestratorStartupPreflightOptions
): Promise<OrchestratorStartupPreflightResult> {
  const singletonGuard = await evaluateDaemonSingletonGuard(options.repoRoot, options.singletonGuardOptions);
  const currentPid = options.currentPid ?? process.pid;
  const ownedByCurrentProcess = singletonGuard.identity?.pid === currentPid;
  if (!singletonGuard.allowed && !ownedByCurrentProcess) {
    const daemonPreflight = {
      ...options.daemonPreflight,
      status: "singleton_conflict" as const,
      message: singletonGuard.message,
      errors: uniqueStrings([...options.daemonPreflight.errors, singletonGuard.message])
    };
    return {
      decision: "refuse",
      allowed: false,
      message: daemonPreflight.message,
      daemonPreflight,
      singletonGuard
    };
  }

  const allowed = preflightAllowsDispatch(options.daemonPreflight);
  return {
    decision: allowed ? "allow" : "refuse",
    allowed,
    message: options.daemonPreflight.message,
    daemonPreflight: options.daemonPreflight,
    singletonGuard
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
