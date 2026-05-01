import type { LifecycleDuplicateCommentBehavior, LifecycleMode, ServiceConfig } from "./types.js";

export const lifecycleModes = ["orchestrator-owned", "hybrid", "agent-owned"] as const;
export const lifecycleDuplicateCommentBehaviors = ["upsert", "skip", "error"] as const;

export interface LifecycleValidationResult {
  errors: string[];
  warnings: string[];
}

export type LifecycleCommentKind = "bookkeeping" | "substantive";

const durableRetryAcknowledgement = "durable retry/startup reconstruction is not yet complete";

export function parseLifecycleConfig(value: unknown): ServiceConfig["lifecycle"] {
  const config = objectRecord(value);
  return {
    mode: parseLifecycleMode(config.mode),
    allowedTrackerTools: stringList(config.allowed_tracker_tools),
    idempotencyMarkerFormat: nullableString(config.idempotency_marker_format),
    allowedStateTransitions: stringList(config.allowed_state_transitions),
    duplicateCommentBehavior: parseDuplicateCommentBehavior(config.duplicate_comment_behavior),
    fallbackBehavior: nullableString(config.fallback_behavior),
    maturityAcknowledgement: nullableString(config.maturity_acknowledgement)
  };
}

export function parseLifecycleMode(value: unknown, fallback: LifecycleMode = "orchestrator-owned"): LifecycleMode {
  if (value == null || value === "") return fallback;
  if (isLifecycleMode(value)) return value;
  throw new Error(`unsupported_lifecycle_mode: ${String(value)}`);
}

export function isLifecycleMode(value: unknown): value is LifecycleMode {
  return typeof value === "string" && lifecycleModes.includes(value as LifecycleMode);
}

export function validateLifecycleConfig(lifecycle: ServiceConfig["lifecycle"], strict = false): LifecycleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (lifecycle.mode === "hybrid") {
    warnings.push("lifecycle.mode=hybrid keeps orchestrator-owned safety/bookkeeping writes while substantive handoff content remains artifact-owned");
  }

  if (lifecycle.mode !== "agent-owned") return { errors, warnings };

  warnings.push("lifecycle.mode=agent-owned is experimental and depends on repo-local tracker tooling");
  if (!strict) return { errors, warnings };

  if (lifecycle.allowedTrackerTools.length === 0) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.allowed_tracker_tools in strict mode");
  }
  if (!lifecycle.idempotencyMarkerFormat) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.idempotency_marker_format in strict mode");
  } else {
    if (!lifecycle.idempotencyMarkerFormat.includes("{event}")) {
      errors.push("lifecycle.idempotency_marker_format must include {event} in strict mode");
    }
    if (!lifecycle.idempotencyMarkerFormat.includes("{issue}")) {
      errors.push("lifecycle.idempotency_marker_format must include {issue} in strict mode");
    }
  }
  if (lifecycle.allowedStateTransitions.length === 0) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.allowed_state_transitions in strict mode");
  }
  if (!lifecycle.duplicateCommentBehavior) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.duplicate_comment_behavior in strict mode");
  }
  if (!lifecycle.fallbackBehavior) {
    errors.push("lifecycle.mode=agent-owned requires lifecycle.fallback_behavior in strict mode");
  }
  if (!lifecycle.maturityAcknowledgement?.includes(durableRetryAcknowledgement)) {
    errors.push(`lifecycle.mode=agent-owned requires lifecycle.maturity_acknowledgement to include "${durableRetryAcknowledgement}" in strict mode`);
  }

  return { errors, warnings };
}

export function orchestratorMayMoveIssue(config: ServiceConfig): boolean {
  return config.lifecycle.mode !== "agent-owned";
}

export function orchestratorMayComment(config: ServiceConfig, kind: LifecycleCommentKind): boolean {
  if (config.lifecycle.mode === "agent-owned") return false;
  if (config.lifecycle.mode === "hybrid" && kind === "substantive") return false;
  return true;
}

export function usesFullOrchestratorHandoff(config: ServiceConfig): boolean {
  return config.lifecycle.mode === "orchestrator-owned";
}

export function hybridHandoffComment(input: { issueIdentifier: string; workspacePath: string; reviewStatus?: string; reviewIteration?: number }): string {
  const reviewLine = input.reviewStatus
    ? [`- Automated review status: \`${input.reviewStatus}\`${input.reviewIteration ? ` after iteration ${input.reviewIteration}` : ""}`]
    : [];
  return [
    "### AgentOS handoff recorded",
    "",
    "AgentOS recorded the agent-authored handoff artifact and durable issue state.",
    "In `lifecycle.mode: hybrid`, substantive handoff content and PR metadata stay owned by the agent artifact/tooling; this comment is only lifecycle bookkeeping.",
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
