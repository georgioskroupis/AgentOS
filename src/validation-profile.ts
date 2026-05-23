import { createHash } from "node:crypto";
import type { ServiceConfig, ValidationReuseProfileState } from "./types.js";

export const VALIDATION_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const VALIDATION_EVIDENCE_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface ValidationReuseProfileComparison {
  status: "matched" | "missing" | "mismatch";
  reasons: string[];
}

export function validationReuseProfileForConfig(config: ServiceConfig): ValidationReuseProfileState {
  const riskProfile = validationRiskProfileForConfig(config);
  const workflowConfigHash = hashStableJson(validationRelevantConfig(config, riskProfile));
  return {
    workflowConfigHash,
    trustMode: config.trustMode,
    automationProfile: config.automation.profile,
    automationRepairPolicy: config.automation.repairPolicy,
    riskProfile
  };
}

export function compareValidationReuseProfiles(
  expected: ValidationReuseProfileState,
  actual: ValidationReuseProfileState | null | undefined
): ValidationReuseProfileComparison {
  if (!actual) {
    return {
      status: "missing",
      reasons: ["validation reuse profile is missing"]
    };
  }
  const comparisons: Array<[keyof ValidationReuseProfileState, string]> = [
    ["workflowConfigHash", "workflow/config hash"],
    ["trustMode", "trust mode"],
    ["automationProfile", "automation profile"],
    ["automationRepairPolicy", "automation repair policy"],
    ["riskProfile", "risk profile"]
  ];
  const reasons = comparisons
    .filter(([key]) => actual[key] !== expected[key])
    .map(([key, label]) => `${label} changed: expected ${expected[key]}, found ${actual[key] ?? "missing"}`);
  return {
    status: reasons.length ? "mismatch" : "matched",
    reasons
  };
}

export function validationTimestampFreshnessError(label: string, value: string | null | undefined, now: Date): string | null {
  if (!value) return `${label} timestamp is missing`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return `${label} timestamp is invalid`;
  if (parsed.getTime() - now.getTime() > VALIDATION_EVIDENCE_MAX_FUTURE_SKEW_MS) {
    return `${label} timestamp is in the future (${parsed.toISOString()} > ${now.toISOString()} + ${VALIDATION_EVIDENCE_MAX_FUTURE_SKEW_MS}ms skew)`;
  }
  if (now.getTime() - parsed.getTime() > VALIDATION_EVIDENCE_MAX_AGE_MS) {
    return `${label} evidence is stale (${parsed.toISOString()} is older than ${VALIDATION_EVIDENCE_MAX_AGE_MS}ms relative to ${now.toISOString()})`;
  }
  return null;
}

function validationRiskProfileForConfig(config: ServiceConfig): string {
  const review = config.review.enabled
    ? [
        "review=enabled",
        `target=${config.review.targetMode ?? "merge-eligible"}`,
        `blocking=${config.review.blockingSeverities.join(",")}`,
        `required=${config.review.requiredReviewers.join(",")}`,
        `optional=${config.review.optionalReviewers.join(",")}`,
        `budget=${config.review.budget.enabled ? config.review.budget.mode : "disabled"}`
      ].join(";")
    : "review=disabled";
  return [
    review,
    `githubChecks=${config.github.requireChecks ? "required" : "not-required"}`,
    `mergeMode=${config.github.mergeMode}`,
    `mergeTarget=${config.github.mergeTarget ?? "primary"}`,
    `lifecycle=${config.lifecycle.mode}`
  ].join("|");
}

function validationRelevantConfig(config: ServiceConfig, riskProfile: string): unknown {
  return {
    trustMode: config.trustMode,
    automation: config.automation,
    lifecycle: {
      mode: config.lifecycle.mode,
      allowedTrackerTools: config.lifecycle.allowedTrackerTools,
      clientTrackerTools: config.lifecycle.clientTrackerTools,
      idempotencyMarkerFormat: config.lifecycle.idempotencyMarkerFormat,
      allowedStateTransitions: config.lifecycle.allowedStateTransitions,
      duplicateCommentBehavior: config.lifecycle.duplicateCommentBehavior,
      fallbackBehavior: config.lifecycle.fallbackBehavior,
      maturityAcknowledgement: config.lifecycle.maturityAcknowledgement,
      trustedDecisionActors: config.lifecycle.trustedDecisionActors
    },
    tracker: {
      kind: config.tracker.kind,
      endpoint: config.tracker.endpoint,
      projectSlug: config.tracker.projectSlug,
      activeStates: config.tracker.activeStates,
      terminalStates: config.tracker.terminalStates,
      runningState: config.tracker.runningState,
      reviewState: config.tracker.reviewState,
      mergeState: config.tracker.mergeState,
      needsInputState: config.tracker.needsInputState
    },
    polling: config.polling,
    workspace: config.workspace,
    hooks: config.hooks,
    agent: {
      maxConcurrentAgents: config.agent.maxConcurrentAgents,
      maxTurns: config.agent.maxTurns,
      maxRetryAttempts: config.agent.maxRetryAttempts,
      maxRetryBackoffMs: config.agent.maxRetryBackoffMs,
      maxConcurrentAgentsByState: [...config.agent.maxConcurrentAgentsByState.entries()].sort(([left], [right]) => left.localeCompare(right))
    },
    contextBudget: config.contextBudget,
    validationBudget: config.validationBudget,
    codex: {
      command: config.codex.command,
      approvalPolicy: config.codex.approvalPolicy,
      approvalEventPolicy: config.codex.approvalEventPolicy,
      userInputPolicy: config.codex.userInputPolicy,
      threadSandbox: config.codex.threadSandbox,
      turnSandboxPolicy: config.codex.turnSandboxPolicy,
      turnTimeoutMs: config.codex.turnTimeoutMs,
      readTimeoutMs: config.codex.readTimeoutMs,
      stallTimeoutMs: config.codex.stallTimeoutMs
    },
    github: config.github,
    daemon: config.daemon,
    review: config.review,
    riskProfile
  };
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}
