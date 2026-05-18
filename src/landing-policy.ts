import { trustCapabilities } from "./trust.js";
import type { GitHubMergeMode, ServiceConfig, TrustMode, AutomationProfile } from "./types.js";

export type LandingPolicyStatus = "enabled" | "disabled" | "blocked";

export interface LandingPolicyInput {
  trustMode: TrustMode;
  automationProfile: AutomationProfile;
  githubMergeMode: GitHubMergeMode;
}

export interface LandingPolicyResult {
  status: LandingPolicyStatus;
  enabled: boolean;
  reasons: string[];
}

export function landingPolicyInputFromConfig(config: ServiceConfig): LandingPolicyInput {
  return {
    trustMode: config.trustMode,
    automationProfile: config.automation.profile,
    githubMergeMode: config.github.mergeMode
  };
}

export function evaluateLandingPolicy(input: LandingPolicyInput): LandingPolicyResult {
  const capabilities = trustCapabilities(input.trustMode);
  const trustReady = capabilities.prNetwork && capabilities.githubMerge;
  const automationReady = input.automationProfile === "high-throughput";
  const mergeReady = input.githubMergeMode !== "manual";
  const landingRequested = automationReady || mergeReady;

  if (trustReady && automationReady && mergeReady) {
    return {
      status: "enabled",
      enabled: true,
      reasons: [
        `trust_mode=${input.trustMode} permits PR/network and merge`,
        "automation.profile=high-throughput",
        `github.merge_mode=${input.githubMergeMode}`
      ]
    };
  }

  if (!landingRequested) {
    return {
      status: "disabled",
      enabled: false,
      reasons: ["automation.profile=conservative", "github.merge_mode=manual keeps auto-ready and auto-merge disabled"]
    };
  }

  return {
    status: "blocked",
    enabled: false,
    reasons: [
      ...(!trustReady ? [`trust_mode=${input.trustMode} lacks PR/network or GitHub merge capability`] : []),
      ...(!automationReady ? [`automation.profile=${input.automationProfile} is not high-throughput`] : []),
      ...(!mergeReady ? ["github.merge_mode=manual keeps auto-ready and auto-merge disabled"] : [])
    ]
  };
}

export function evaluateLandingPolicyForConfig(config: ServiceConfig): LandingPolicyResult {
  return evaluateLandingPolicy(landingPolicyInputFromConfig(config));
}

export function formatLandingPolicyResult(result: LandingPolicyResult): string {
  return `${result.status}: ${result.reasons.join("; ")}`;
}
