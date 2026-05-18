import { withGitHubCredentialPreflight, type DaemonPreflightResult } from "./env.js";
import { verifyGitHubCli, type PullRequestStatus } from "./github.js";
import { evaluateLandingPolicyForConfig, formatLandingPolicyResult } from "./landing-policy.js";
import { evaluateLandingPreflight, formatLandingPreflightResult, type LandingPreflightStatus } from "./landing-preflight.js";
import type { JsonlLogger } from "./logging.js";
import { formatPullRequestTargets } from "./orchestrator-review-helpers.js";
import type { RuntimeStateStore } from "./runtime-state.js";
import type { IssueState, PullRequestRef, ServiceConfig } from "./types.js";

type RuntimeReader = Pick<RuntimeStateStore, "read">;
type LogWriter = Pick<JsonlLogger, "write">;

export async function daemonPreflightWithLandingCredentialCheck(config: ServiceConfig, preflight: DaemonPreflightResult, repoRoot: string): Promise<DaemonPreflightResult> {
  const landing = evaluateLandingPolicyForConfig(config);
  if (!landing.enabled || preflight.status !== "ready" || !preflight.github.required) return preflight;
  const githubAuth = await verifyGitHubCli(config.github.command, repoRoot);
  return withGitHubCredentialPreflight(preflight, githubAuth.ok ? "present" : "missing");
}

export async function runLandingShepherdGate(input: {
  config: ServiceConfig;
  preflight: DaemonPreflightResult | null;
  runtimeState: RuntimeReader;
  logger: LogWriter;
  shepherd: () => Promise<void>;
}): Promise<void> {
  const landing = evaluateLandingPolicyForConfig(input.config);
  if (landing.enabled) {
    const runtime = await input.runtimeState.read();
    const preflight = evaluateLandingPreflight({ config: input.config, daemon: runtime.daemon, credentials: input.preflight, requireFreshness: false });
    if (preflight.ready) await input.shepherd();
    else await input.logger.write({ type: "landing_preflight_blocked", message: formatLandingPreflightResult(preflight), payload: { landing, preflight } });
  } else if (input.config.github.mergeMode !== "manual") {
    await input.logger.write({ type: `landing_${landing.status}`, message: `merge shepherd ${formatLandingPolicyResult(landing)}`, payload: { landing } });
  }
}

export function noPrMergeApprovalComment(state: IssueState): string {
  return [
    "### AgentOS merge shepherd",
    "",
    "No merge-eligible pull request output was selected for this issue. Treating the configured merge-state move as approval of the handoff without a merge.",
    "",
    state.prs?.length ? formatPullRequestTargets(state.prs) : "- PRs: none",
    "- Result: moving issue to Done"
  ].join("\n");
}

export interface ApprovedPrLandingPreflightBlock {
  status: LandingPreflightStatus;
  message: string;
  statePatch: Partial<IssueState>;
  payload: Record<string, unknown>;
}

export async function approvedPrLandingPreflightBlock(input: {
  config: ServiceConfig;
  preflight: DaemonPreflightResult | null;
  runtimeState: RuntimeReader;
  state: IssueState;
  pullRequest: PullRequestStatus;
  mergeTarget: Pick<PullRequestRef, "url" | "role">;
}): Promise<ApprovedPrLandingPreflightBlock | null> {
  const runtime = await input.runtimeState.read();
  const preflight = evaluateLandingPreflight({
    config: input.config,
    daemon: runtime.daemon,
    credentials: input.preflight,
    state: input.state,
    pullRequest: input.pullRequest,
    requireFreshness: Boolean(input.state.validation || input.config.review.enabled)
  });
  if (preflight.ready) return null;
  const message = `approved PR landing preflight ${preflight.status}: ${formatLandingPreflightResult(preflight)}`;
  return {
    status: preflight.status,
    message,
    statePatch: {
      phase: input.state.phase,
      mergeTargetUrl: input.mergeTarget.url,
      mergeTargetRole: input.mergeTarget.role ?? "primary",
      stopReason: message,
      nextRetryAt: undefined,
      retryAttempt: undefined
    },
    payload: { prUrl: input.mergeTarget.url, landingPreflight: preflight }
  };
}

export interface MergeShepherdLandingPreflightBlock {
  status: LandingPreflightStatus;
  reason: string;
  timingStatus: "waiting" | "failed";
  timingLabel: string;
  timingMetadata: Record<string, unknown>;
}

export async function mergeShepherdLandingPreflightBlock(input: {
  config: ServiceConfig;
  preflight: DaemonPreflightResult | null;
  runtimeState: RuntimeReader;
  state: IssueState;
  pullRequest: PullRequestStatus;
  prUrl: string;
}): Promise<MergeShepherdLandingPreflightBlock | null> {
  const runtime = await input.runtimeState.read();
  const preflight = evaluateLandingPreflight({
    config: input.config,
    daemon: runtime.daemon,
    credentials: input.preflight,
    state: input.state,
    pullRequest: input.pullRequest,
    requireFreshness: Boolean(input.state.validation || (input.state.reviewStatus === "approved" && input.config.review.enabled))
  });
  if (preflight.ready) return null;
  const reason = formatLandingPreflightResult(preflight);
  return {
    status: preflight.status,
    reason,
    timingStatus: preflight.status === "waiting" ? "waiting" : "failed",
    timingLabel: preflight.status === "waiting" ? "merge shepherding waiting on landing preflight" : "merge shepherding failed",
    timingMetadata: { prUrl: input.prUrl, reason, landingPreflight: preflight }
  };
}
