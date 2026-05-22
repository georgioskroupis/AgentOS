import type { ModelCostBucket, ModelRolePolicy, ModelRouteDecision, ModelRoutingConfig, ModelRoutingInput, ModelRoutingMode, ModelRoutingRole, ModelTelemetryEntry } from "./types.js";

export const MODEL_ROUTING_ROLES = [
  "implementation",
  "fixer",
  "ci-repair",
  "self-review",
  "correctness-review",
  "tests-review",
  "architecture-review",
  "security-review",
  "planning",
  "summarization-status"
] as const;

const highCapabilityRoles = new Set<ModelRoutingRole>(["implementation", "fixer", "ci-repair", "architecture-review", "security-review", "planning"]);
const writeCapableRoles = new Set<ModelRoutingRole>(["implementation", "fixer", "ci-repair", "planning"]);

export function defaultModelRoutingConfig(): ModelRoutingConfig {
  return { mode: "off", roles: {} };
}

export function parseModelRoutingConfig(value: Record<string, unknown>): ModelRoutingConfig {
  const mode = modelRoutingMode(value.mode);
  const rolesInput = objectValue(value.roles);
  const roles: Partial<Record<ModelRoutingRole, ModelRolePolicy>> = {};
  for (const role of MODEL_ROUTING_ROLES) {
    const raw = objectValue(rolesInput[role]);
    if (Object.keys(raw).length === 0) continue;
    roles[role] = {
      ...(stringValue(raw.model) ? { model: stringValue(raw.model) } : {}),
      ...(stringValue(raw.reasoning_effort ?? raw.reasoningEffort) ? { reasoningEffort: stringValue(raw.reasoning_effort ?? raw.reasoningEffort) } : {}),
      ...(modelCostBucket(raw.cost_bucket ?? raw.costBucket) ? { costBucket: modelCostBucket(raw.cost_bucket ?? raw.costBucket)! } : {}),
      ...(stringValue(raw.promote_to_model ?? raw.promoteToModel) ? { promoteToModel: stringValue(raw.promote_to_model ?? raw.promoteToModel) } : {}),
      ...(stringValue(raw.promote_reasoning_effort ?? raw.promoteReasoningEffort) ? { promoteReasoningEffort: stringValue(raw.promote_reasoning_effort ?? raw.promoteReasoningEffort) } : {}),
      ...(typeof (raw.allow_write_capable_downgrade ?? raw.allowWriteCapableDowngrade) === "boolean" ? { allowWriteCapableDowngrade: Boolean(raw.allow_write_capable_downgrade ?? raw.allowWriteCapableDowngrade) } : {})
    };
  }
  for (const role of Object.keys(rolesInput)) {
    if (!MODEL_ROUTING_ROLES.includes(role as ModelRoutingRole)) throw new Error(`unsupported_model_routing_role: ${role}`);
  }
  return { mode, roles };
}

export function selectModelRoute(config: ModelRoutingConfig, input: ModelRoutingInput): ModelRouteDecision {
  const policy = config.roles[input.role];
  const configured = Boolean(policy?.model || policy?.reasoningEffort);
  const escalationReason = escalationReasonFor(input);
  const sensitive = highCapabilityRoles.has(input.role) || (input.risk ?? []).some((risk) => /security|recovery|retry|credential|secret|merge|lifecycle/i.test(risk));
  const refusedReason = configured && sensitive && !policy?.allowWriteCapableDowngrade ? "high_capability_or_sensitive_scope" : configured && writeCapableRoles.has(input.role) && !policy?.allowWriteCapableDowngrade ? "write_capable_role" : null;
  const proposedModel = policy?.model ?? null;
  const proposedReasoningEffort = policy?.reasoningEffort ?? null;
  const promotedModel = escalationReason ? (policy?.promoteToModel ?? "inherited") : null;
  const promotedReasoningEffort = escalationReason ? (policy?.promoteReasoningEffort ?? null) : null;
  const canApply = config.mode === "apply" && configured && !refusedReason && !escalationReason;
  return {
    role: input.role,
    mode: config.mode,
    applied: canApply,
    configured,
    model: canApply ? proposedModel! : (promotedModel ?? "inherited"),
    reasoningEffort: canApply ? proposedReasoningEffort : promotedReasoningEffort,
    proposedModel,
    proposedReasoningEffort,
    costBucket: canApply || (config.mode === "report-only" && configured) ? (policy?.costBucket ?? "unknown") : "inherited",
    escalationReason,
    refusedReason
  };
}

export function modelTelemetry(decision: ModelRouteDecision, input: { elapsedMs: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; recordedAt?: string }): ModelTelemetryEntry {
  return {
    ...decision,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    elapsedMs: input.elapsedMs,
    tokenUsage: {
      ...(input.inputTokens != null ? { input: input.inputTokens } : {}),
      ...(input.outputTokens != null ? { output: input.outputTokens } : {}),
      ...(input.totalTokens != null ? { total: input.totalTokens } : {})
    }
  };
}

export function reviewerRole(reviewer: string): ModelRoutingRole {
  if (reviewer === "self") return "self-review";
  if (reviewer === "correctness") return "correctness-review";
  if (reviewer === "tests") return "tests-review";
  if (reviewer === "architecture") return "architecture-review";
  if (reviewer === "security") return "security-review";
  return "self-review";
}

function escalationReasonFor(input: ModelRoutingInput): string | null {
  if (input.artifactFailure === "malformed_artifact") return "malformed_artifact";
  if (input.artifactFailure === "incomplete_artifact") return "incomplete_artifact";
  if ((input.attempt ?? 1) > 1) return "repeated_iteration";
  if ((input.risk ?? []).some((risk) => /ambiguous|human|required/i.test(risk))) return "ambiguous_or_human_required";
  return null;
}

function modelRoutingMode(value: unknown): ModelRoutingMode {
  if (value == null) return "off";
  if (value === "off" || value === "report-only" || value === "apply") return value;
  throw new Error(`unsupported_model_routing_mode: ${String(value)}`);
}

function modelCostBucket(value: unknown): ModelCostBucket | null {
  return value === "low" || value === "standard" || value === "high" || value === "unknown" || value === "inherited" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
