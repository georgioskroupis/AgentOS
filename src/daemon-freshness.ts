import { daemonRestartCommand } from "./daemon-health.js";
import { gitLsRemoteBranch, gitRevParse } from "./orchestrator-state-helpers.js";
import type { RuntimeDaemonState } from "./runtime-state.js";

export interface DaemonFreshnessState {
  startGitSha: string | null;
  startMainGitSha: string | null;
  currentMainGitSha: string | null;
  runtimeTick: number;
  lastMainRefreshTick: number;
}

export interface DaemonFreshnessResult extends DaemonFreshnessState {
  currentGitSha: string | null;
  freshnessStatus: NonNullable<RuntimeDaemonState["freshnessStatus"]>;
  freshnessMessage: string | null;
}

export function initialDaemonFreshnessState(): DaemonFreshnessState {
  return {
    startGitSha: null,
    startMainGitSha: null,
    currentMainGitSha: null,
    runtimeTick: 0,
    lastMainRefreshTick: 0
  };
}

export async function refreshDaemonFreshness(input: {
  state: DaemonFreshnessState;
  repoRoot: string;
  mainBranch: string;
  refreshIntervalTicks: number;
  forceMainRefresh?: boolean;
}): Promise<DaemonFreshnessResult> {
  const runtimeTick = input.state.runtimeTick + 1;
  const startGitSha = input.state.startGitSha ?? (await gitRevParse(input.repoRoot, "HEAD"));
  const startMainGitSha = input.state.startMainGitSha ?? (await localMainBranchGitSha(input.repoRoot, input.mainBranch));
  const currentGitSha = await gitRevParse(input.repoRoot, "HEAD");
  let currentMainGitSha = input.state.currentMainGitSha;
  let lastMainRefreshTick = input.state.lastMainRefreshTick;
  if (input.forceMainRefresh || currentMainGitSha == null || runtimeTick - lastMainRefreshTick >= input.refreshIntervalTicks) {
    currentMainGitSha = await currentMainBranchGitSha(input.repoRoot, input.mainBranch);
    lastMainRefreshTick = runtimeTick;
  }
  const mainAdvanced = Boolean(startMainGitSha && currentMainGitSha && startMainGitSha !== currentMainGitSha);
  return {
    startGitSha,
    startMainGitSha,
    currentGitSha,
    currentMainGitSha,
    runtimeTick,
    lastMainRefreshTick,
    freshnessStatus: mainAdvanced ? "stale" : "fresh",
    freshnessMessage: mainAdvanced ? `${input.mainBranch} advanced from ${startMainGitSha} to ${currentMainGitSha}; run git pull && ${daemonRestartCommand(input.repoRoot)}` : null
  };
}

export function isDaemonFreshnessStale(status: string | null | undefined): boolean {
  return status === "stale" || status === "main_advanced";
}

async function localMainBranchGitSha(repoRoot: string, branch: string): Promise<string | null> {
  return gitRevParse(repoRoot, branch).then((sha) => sha ?? gitRevParse(repoRoot, `origin/${branch}`));
}

async function currentMainBranchGitSha(repoRoot: string, branch: string): Promise<string | null> {
  return gitLsRemoteBranch(repoRoot, "origin", branch).then((sha) => sha ?? gitRevParse(repoRoot, `origin/${branch}`).then((fallback) => fallback ?? gitRevParse(repoRoot, branch)));
}
