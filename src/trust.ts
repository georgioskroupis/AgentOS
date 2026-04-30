import type { CodexEventPolicy, GitHubMergeMode, TrustMode } from "./types.js";

export const trustModes = ["review-only", "ci-locked", "local-trusted", "danger"] as const;

export interface TrustCapabilities {
  mode: TrustMode;
  network: boolean;
  repoWrite: boolean;
  reviewWrite: boolean;
  prNetwork: boolean;
  githubMerge: boolean;
  codexUserInput: "deny" | "allow";
}

export interface TrustCompatibilityResult {
  errors: string[];
  warnings: string[];
}

const capabilityMatrix: Record<TrustMode, TrustCapabilities> = {
  "review-only": {
    mode: "review-only",
    network: false,
    repoWrite: false,
    reviewWrite: true,
    prNetwork: false,
    githubMerge: false,
    codexUserInput: "deny"
  },
  "ci-locked": {
    mode: "ci-locked",
    network: false,
    repoWrite: true,
    reviewWrite: true,
    prNetwork: false,
    githubMerge: false,
    codexUserInput: "deny"
  },
  "local-trusted": {
    mode: "local-trusted",
    network: true,
    repoWrite: true,
    reviewWrite: true,
    prNetwork: true,
    githubMerge: true,
    codexUserInput: "deny"
  },
  danger: {
    mode: "danger",
    network: true,
    repoWrite: true,
    reviewWrite: true,
    prNetwork: true,
    githubMerge: true,
    codexUserInput: "allow"
  }
};

export function trustCapabilities(mode: TrustMode): TrustCapabilities {
  return capabilityMatrix[mode];
}

export function parseTrustMode(value: unknown, fallback: TrustMode = "ci-locked"): TrustMode {
  if (value == null || value === "") return fallback;
  if (isTrustMode(value)) return value;
  throw new Error(`unsupported_trust_mode: ${String(value)}`);
}

export function isTrustMode(value: unknown): value is TrustMode {
  return typeof value === "string" && trustModes.includes(value as TrustMode);
}

export function parseGitHubMergeMode(value: unknown, fallback: GitHubMergeMode = "manual"): GitHubMergeMode {
  if (value == null || value === "") return fallback;
  if (value === "manual" || value === "shepherd" || value === "auto") return value;
  throw new Error(`unsupported_github_merge_mode: ${String(value)}`);
}

export function defaultThreadSandboxForTrustMode(mode: TrustMode): unknown {
  if (mode === "review-only") return "read-only";
  if (mode === "danger") return "danger-full-access";
  return "workspace-write";
}

export function defaultTurnSandboxPolicyForTrustMode(mode: TrustMode): Record<string, unknown> {
  if (mode === "review-only") {
    return { type: "readOnly", networkAccess: false };
  }
  if (mode === "danger") {
    return { type: "dangerFullAccess", networkAccess: true };
  }
  return { type: "workspaceWrite", networkAccess: mode === "local-trusted" };
}

export function validateTrustCompatibility(input: {
  trustMode: TrustMode;
  githubMergeMode: GitHubMergeMode;
  turnSandboxPolicy?: unknown;
  reviewEnabled?: boolean;
  approvalEventPolicy?: CodexEventPolicy;
  userInputPolicy?: CodexEventPolicy;
}): TrustCompatibilityResult {
  const capabilities = trustCapabilities(input.trustMode);
  const errors: string[] = [];
  const warnings: string[] = [];
  const networkAccess = sandboxNetworkAccess(input.turnSandboxPolicy);

  if (networkAccess === true && !capabilities.network) {
    errors.push(`codex.turn_sandbox_policy.networkAccess=true is incompatible with trust_mode=${input.trustMode}`);
  }
  if (sandboxAllowsRepoWrite(input.turnSandboxPolicy) && !capabilities.repoWrite) {
    errors.push(`codex.turn_sandbox_policy allows repository writes but trust_mode=${input.trustMode} is review-only`);
  }
  if (input.githubMergeMode !== "manual" && !capabilities.githubMerge) {
    errors.push(`github.merge_mode=${input.githubMergeMode} requires a trust mode with GitHub merge capability`);
  }
  if (input.githubMergeMode !== "manual" && !capabilities.prNetwork) {
    errors.push(`github.merge_mode=${input.githubMergeMode} requires PR/network capability`);
  }
  if (input.reviewEnabled && !capabilities.prNetwork) {
    warnings.push(`trust_mode=${input.trustMode} disables PR/network access; automated PR review context may be unavailable`);
  }
  if (input.githubMergeMode === "auto") {
    warnings.push("github.merge_mode=auto currently uses the same merge-state shepherd path as shepherd");
  }
  if (input.approvalEventPolicy === "allow" && input.trustMode !== "danger") {
    errors.push(`codex.approval_event_policy=allow requires trust_mode=danger`);
  }
  if (input.userInputPolicy === "allow" && capabilities.codexUserInput !== "allow") {
    errors.push(`codex.user_input_policy=allow requires a trust mode with Codex user input capability`);
  }

  return { errors, warnings };
}

function sandboxNetworkAccess(policy: unknown): boolean | null {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const raw = (policy as Record<string, unknown>).networkAccess;
  return typeof raw === "boolean" ? raw : null;
}

function sandboxAllowsRepoWrite(policy: unknown): boolean {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return true;
  const rawType = (policy as Record<string, unknown>).type;
  return rawType === "workspaceWrite" || rawType === "workspace-write" || rawType === "dangerFullAccess" || rawType === "danger-full-access";
}
