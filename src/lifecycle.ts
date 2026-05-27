import type { LifecycleDuplicateCommentBehavior, LifecycleMode, ServiceConfig } from "./types.js";

export const lifecycleModes = ["agent-owned"] as const;
const publicLifecycleModes = lifecycleModes;
const legacyLifecycleModes = ["orchestrator-owned", "hybrid"] as const;
export const lifecycleDuplicateCommentBehaviors = ["upsert", "skip", "error"] as const;
export const requiredAgentLifecycleTools = [
  "scripts/agent-linear-comment.sh",
  "scripts/agent-linear-move.sh",
  "scripts/agent-linear-pr.sh",
  "scripts/agent-linear-handoff.sh"
] as const;
export const lifecycleClientTrackerTools = ["linear_graphql"] as const;

export interface LifecycleValidationResult {
  errors: string[];
  warnings: string[];
}

export type LifecycleCommentKind = "bookkeeping" | "substantive";

export function parseLifecycleConfig(value: unknown): ServiceConfig["lifecycle"] {
  const config = objectRecord(value);
  return {
    mode: parseLifecycleMode(config.mode),
    allowedTrackerTools: stringList(config.allowed_tracker_tools),
    clientTrackerTools: stringList(config.client_tracker_tools),
    idempotencyMarkerFormat: nullableString(config.idempotency_marker_format),
    allowedStateTransitions: stringList(config.allowed_state_transitions),
    duplicateCommentBehavior: parseDuplicateCommentBehavior(config.duplicate_comment_behavior),
    fallbackBehavior: nullableString(config.fallback_behavior),
    maturityAcknowledgement: nullableString(config.maturity_acknowledgement),
    trustedDecisionActors: stringList(config.trusted_decision_actors ?? config.trusted_human_decision_actors)
  };
}

export function parseLifecycleMode(value: unknown, fallback: LifecycleMode = "agent-owned"): LifecycleMode {
  if (value == null || value === "") return fallback;
  if (legacyLifecycleModes.includes(value as (typeof legacyLifecycleModes)[number])) {
    throw new Error(`legacy_lifecycle_mode_disabled: ${String(value)}; use agent-owned`);
  }
  if (isLifecycleMode(value)) return value;
  throw new Error(`unsupported_lifecycle_mode: ${String(value)}`);
}

export function isLifecycleMode(value: unknown): value is LifecycleMode {
  return typeof value === "string" && publicLifecycleModes.includes(value as (typeof publicLifecycleModes)[number]);
}

export function validateLifecycleConfig(lifecycle: ServiceConfig["lifecycle"], strict = false): LifecycleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (lifecycle.mode !== "agent-owned") return { errors, warnings };

  warnings.push("lifecycle.mode=agent-owned depends on repo-local tracker tooling and post-run evidence verification");
  if (!strict) return { errors, warnings };

  if (lifecycle.allowedTrackerTools.length === 0) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.allowed_tracker_tools in strict mode");
  } else {
    for (const tool of requiredAgentLifecycleTools) {
      if (!lifecycle.allowedTrackerTools.map(normalizeToolName).includes(normalizeToolName(tool))) {
        errors.push(`lifecycle.allowed_tracker_tools must include ${tool} in strict mode`);
      }
    }
    if (lifecycle.allowedTrackerTools.map(normalizeToolName).includes("linear_graphql")) {
      errors.push("linear_graphql must be configured through lifecycle.client_tracker_tools, not lifecycle.allowed_tracker_tools");
    }
  }
  if (!lifecycle.idempotencyMarkerFormat) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.idempotency_marker_format in strict mode");
  } else {
    for (const token of ["{event}", "{issue}", "{run}", "{attempt}"]) {
      if (!lifecycle.idempotencyMarkerFormat.includes(token)) {
        errors.push(`lifecycle.idempotency_marker_format must include ${token} in strict mode`);
      }
    }
  }
  if (lifecycle.allowedStateTransitions.length === 0) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.allowed_state_transitions in strict mode");
  } else {
    for (const transition of lifecycle.allowedStateTransitions) {
      if (!/^\s*.+?\s*->\s*.+?\s*$/.test(transition)) {
        errors.push(`invalid_allowed_state_transition: ${transition}`);
      }
    }
  }
  if (!lifecycle.duplicateCommentBehavior) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.duplicate_comment_behavior in strict mode");
  }
  if (!lifecycle.fallbackBehavior) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.fallback_behavior in strict mode");
  } else {
    const fallback = lifecycle.fallbackBehavior.toLowerCase();
    if (!fallback.includes("handoff") || !fallback.includes("human_required")) {
      errors.push("lifecycle.fallback_behavior must include handoff and human_required in strict mode");
    }
  }
  for (const tool of lifecycle.clientTrackerTools) {
    if (!lifecycleClientTrackerTools.includes(tool as (typeof lifecycleClientTrackerTools)[number])) {
      errors.push(`unsupported_lifecycle_client_tracker_tool: ${tool}`);
    }
  }

  return { errors, warnings };
}

export function orchestratorMayMoveIssue(config: ServiceConfig): boolean {
  return isTestOnlyOrchestratorLifecycleFixture(config);
}

export function orchestratorMayComment(config: ServiceConfig, kind: LifecycleCommentKind): boolean {
  void kind;
  return isTestOnlyOrchestratorLifecycleFixture(config);
}

export function lifecycleAllowsClientTrackerTools(config: ServiceConfig): boolean {
  return config.lifecycle?.mode === "agent-owned" && config.lifecycle.clientTrackerTools.includes("linear_graphql");
}

export function schedulerBookkeepingHandoffComment(input: { issueIdentifier: string; workspacePath: string; reviewStatus?: string; reviewIteration?: number }): string {
  const reviewLine = input.reviewStatus
    ? [`- Automated review status: \`${input.reviewStatus}\`${input.reviewIteration ? ` after iteration ${input.reviewIteration}` : ""}`]
    : [];
  return [
    "### AgentOS handoff recorded",
    "",
    "AgentOS recorded the agent-authored handoff artifact and durable issue state.",
    "Substantive handoff content and PR metadata stay owned by agent artifacts or repo-local lifecycle tools; this scheduler comment is bookkeeping only.",
    "",
    `- Handoff artifact: \`.agent-os/handoff-${input.issueIdentifier}.md\``,
    `- Workspace: \`${input.workspacePath}\``,
    ...reviewLine
  ].join("\n");
}

function parseDuplicateCommentBehavior(value: unknown): LifecycleDuplicateCommentBehavior | null {
  if (value == null || value === "") return null;
  if (lifecycleDuplicateCommentBehaviors.includes(value as LifecycleDuplicateCommentBehavior)) return value as LifecycleDuplicateCommentBehavior;
  throw new Error(`unsupported_lifecycle_duplicate_comment_behavior: ${String(value)}`);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeToolName(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

function isTestOnlyOrchestratorLifecycleFixture(config: ServiceConfig): boolean {
  return process.env.VITEST === "true" && config.lifecycle.maturityAcknowledgement === "test-only-orchestrator-lifecycle-fixture";
}
