import type { DaemonPreflightResult } from "./env.js";
import type { PullRequestStatus } from "./github.js";
import type { IssueState, ServiceConfig, ValidationState } from "./types.js";
import type { RuntimeDaemonState } from "./runtime-state.js";
import { compareValidationReuseProfiles, validationReuseProfileForConfig, validationTimestampFreshnessError } from "./validation-profile.js";

export type LandingPreflightStatus = "ready" | "blocked" | "waiting";

export interface LandingPreflightResult {
  status: LandingPreflightStatus;
  ready: boolean;
  reasons: string[];
  guidance: string[];
}

export interface LandingPreflightInput {
  config: ServiceConfig;
  daemon?: RuntimeDaemonState | null;
  credentials?: DaemonPreflightResult | null;
  state?: IssueState | null;
  pullRequest?: PullRequestStatus | null;
  requireFreshness?: boolean;
  now?: Date;
}

export function evaluateLandingPreflight(input: LandingPreflightInput): LandingPreflightResult {
  const reasons: string[] = [];
  const guidance: string[] = [];
  const credentials = input.credentials;
  if (!credentials || credentials.status !== "ready") {
    reasons.push(credentials?.message ?? "landing credential preflight has not completed successfully");
    guidance.push("fix the daemon credential preflight, then restart or rerun AgentOS before landing");
  }
  if (credentials?.tracker.linearApiKey !== "present" || credentials?.tracker.projectSlug !== "present") {
    reasons.push("tracker credentials are unavailable for landing");
    guidance.push("set a valid tracker.api_key/LINEAR_API_KEY and tracker.project_slug before landing");
  }
  if (credentials?.github.required && (credentials.github.command !== "configured" || credentials.github.auth !== "present")) {
    reasons.push("GitHub credentials are unavailable for landing");
    guidance.push("run `gh auth status`, then `gh auth login` or provide a valid GH_TOKEN/GITHUB_TOKEN for the configured github.command");
  }
  if (credentials?.codex.command !== "configured") {
    reasons.push("Codex App Server command is unavailable for landing");
    guidance.push("configure codex.command before dispatching or landing AgentOS work");
  }
  if (input.daemon?.freshnessStatus === "stale" || input.daemon?.freshnessStatus === "main_advanced") {
    reasons.push(input.daemon.freshnessMessage ?? "daemon main freshness is stale");
    guidance.push("run `git pull && bin/agent-os daemon restart --repo . --workflow WORKFLOW.md` from the updated main branch before landing");
  }

  if (input.requireFreshness) {
    const freshness = landingHeadFreshness(input.config, input.state, input.pullRequest, input.now ?? new Date());
    reasons.push(...freshness.reasons);
    guidance.push(...freshness.guidance);
  }

  const waiting = reasons.some((reason) => /pending/i.test(reason));
  return {
    status: reasons.length === 0 ? "ready" : waiting ? "waiting" : "blocked",
    ready: reasons.length === 0,
    reasons: unique(reasons),
    guidance: unique(guidance)
  };
}

export function formatLandingPreflightResult(result: LandingPreflightResult): string {
  if (result.ready) return "landing preflight ready";
  const guidance = result.guidance.length ? ` Next safe action: ${result.guidance.join("; ")}` : "";
  return `${result.reasons.join("; ")}.${guidance}`;
}

export function githubCiFromPullRequest(status: PullRequestStatus, requireChecks: boolean, now = new Date()): NonNullable<ValidationState["githubCi"]> | null {
  if (!status.headSha) return null;
  const checkedAt = now.toISOString();
  if (status.checkSummary.failing > 0) return { status: "failed", headSha: status.headSha, source: "github", checkedAt, reused: false };
  if (status.checkSummary.pending > 0) return { status: "pending", headSha: status.headSha, source: "github", checkedAt, reused: false };
  if (status.checkSummary.successful > 0) return { status: "passed", headSha: status.headSha, source: "github", checkedAt, reused: false };
  return requireChecks ? null : null;
}

export function landingFreshnessPatch(
  state: IssueState,
  pullRequest: PullRequestStatus,
  requireChecks: boolean,
  now = new Date()
): Pick<Partial<IssueState>, "headSha" | "validation"> {
  const headSha = pullRequest.headSha ?? state.headSha ?? null;
  const githubCi = githubCiEvidenceForLanding(state.validation?.githubCi ?? null, pullRequest, requireChecks, now);
  return {
    headSha,
    ...(state.validation
      ? {
          validation: {
            ...state.validation,
            ...(githubCi ? { githubCi } : {})
          }
        }
      : {})
  };
}

function landingHeadFreshness(
  config: ServiceConfig,
  state: IssueState | null | undefined,
  pullRequest: PullRequestStatus | null | undefined,
  now: Date
): Pick<LandingPreflightResult, "reasons" | "guidance"> {
  const reasons: string[] = [];
  const guidance: string[] = [];
  const selectedHead = pullRequest?.headSha ?? state?.headSha ?? null;
  if (!selectedHead) {
    reasons.push("selected PR head is unavailable for landing freshness");
    guidance.push("refresh GitHub PR metadata so AgentOS can compare validation and check evidence with the selected head");
  }

  const validation = state?.validation;
  const validationPassed = validation?.status === "passed" || validation?.finalStatus === "passed";
  if (!validation) {
    reasons.push("validation evidence is missing before landing");
    guidance.push("rerun validation and record Validation-JSON evidence before moving the issue to the configured merge state");
  } else if (!validationPassed) {
    reasons.push(`validation evidence is not passing before landing (status=${validation.status}${validation.finalStatus ? `, final=${validation.finalStatus}` : ""})`);
    guidance.push("repair or rerun validation before landing");
  }

  const validationHead = validation?.repoHead ?? null;
  if (validation && !validationHead) {
    reasons.push("validation repoHead is missing before landing");
    guidance.push("rerun validation with the current git rev-parse HEAD recorded in Validation-JSON");
  } else if (validationHead && selectedHead && !sameSha(validationHead, selectedHead)) {
    reasons.push(`validation repoHead ${shortSha(validationHead)} is stale; expected selected PR head ${shortSha(selectedHead)}`);
    guidance.push("rerun validation on the selected PR head before landing");
  }

  const ci = validation?.githubCi;
  if (!ci) {
    reasons.push("GitHub check head is missing before landing");
    guidance.push("wait for GitHub Actions to report on the selected PR head, then rerun landing preflight");
  } else if (!ci.headSha) {
    reasons.push("GitHub check head is unknown before landing");
    guidance.push("refresh GitHub Actions status so AgentOS can compare the check head with the selected PR head");
  } else if (selectedHead && !sameSha(ci.headSha, selectedHead)) {
    reasons.push(`GitHub check head ${shortSha(ci.headSha)} is stale; expected selected PR head ${shortSha(selectedHead)}`);
    guidance.push("wait for GitHub Actions to pass on the selected PR head before landing");
  }
  if (ci?.status === "pending") {
    reasons.push("GitHub checks are pending for the selected PR head");
    guidance.push("wait for GitHub Actions to finish before landing");
  } else if (ci?.status === "failed") {
    reasons.push("GitHub checks are failing for the selected PR head");
    guidance.push("repair the failing checks before landing");
  }
  if (validation) {
    const expectedProfile = validationReuseProfileForConfig(config);
    const profile = compareValidationReuseProfiles(expectedProfile, validation.reuseProfile);
    if (profile.status !== "matched") {
      reasons.push(
        profile.status === "missing"
          ? "validation evidence is missing workflow/config, trust, automation, and risk profile metadata"
          : `validation evidence profile is stale: ${profile.reasons.join("; ")}`
      );
      guidance.push("rerun validation under the current workflow/config, trust, automation, and risk profile before landing");
    }
    const fullValidationCommand = validation.budget?.fullValidationCommand ?? config.validationBudget.fullValidationCommand;
    const validationLabel = validation.budget?.status === "reused" ? `${fullValidationCommand} reuse` : fullValidationCommand;
    const localFinishedAt = latestCommandFinishedAt(validation, fullValidationCommand);
    const localFreshnessError = validationTimestampFreshnessError(validationLabel, localFinishedAt, now);
    if (localFreshnessError) {
      reasons.push(localFreshnessError);
      guidance.push("rerun local validation before landing");
    }
    const ciFreshnessError = validationTimestampFreshnessError(ci?.reused ? "GitHub CI reuse" : "GitHub CI", ci?.checkedAt, now);
    if (ciFreshnessError) {
      reasons.push(ciFreshnessError);
      guidance.push("refresh GitHub Actions status for the selected PR head before landing");
    }
  }

  return { reasons, guidance };
}

function githubCiEvidenceForLanding(
  existingCi: NonNullable<ValidationState["githubCi"]> | null,
  pullRequest: PullRequestStatus,
  requireChecks: boolean,
  now: Date
): NonNullable<ValidationState["githubCi"]> | null {
  const currentCi = githubCiFromPullRequest(pullRequest, requireChecks, now);
  if (!currentCi || currentCi.status !== "passed" || !existingCi) return currentCi;
  if (existingCi.status !== "passed" || !sameSha(existingCi.headSha, currentCi.headSha)) return currentCi;
  if (validationTimestampFreshnessError("GitHub CI reuse", existingCi.checkedAt, now)) return currentCi;
  return {
    ...existingCi,
    source: existingCi.source ?? "github",
    reused: true
  };
}

function latestCommandFinishedAt(validation: ValidationState, commandName: string): string | null {
  const matching = (validation.acceptedCommands ?? [])
    .filter((command) => command.name === commandName)
    .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt));
  return matching[0]?.finishedAt ?? validation.checkedAt ?? null;
}

function sameSha(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
