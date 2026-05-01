import type { AutomationProfile, AutomationRepairPolicy, ServiceConfig } from "./types.js";

export const automationProfiles = ["conservative", "high-throughput"] as const;
export const automationRepairPolicies = ["conservative", "mechanical-first"] as const;

export interface AutomationValidationResult {
  errors: string[];
  warnings: string[];
}

export function parseAutomationConfig(value: unknown): ServiceConfig["automation"] {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    profile: automationProfileAt(config.profile),
    repairPolicy: automationRepairPolicyAt(config.repair_policy ?? config.repairPolicy)
  };
}

export function validateAutomationConfig(automation: ServiceConfig["automation"]): AutomationValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!automationProfiles.includes(automation.profile)) {
    errors.push(`unsupported_automation_profile: ${String(automation.profile)}`);
  }
  if (!automationRepairPolicies.includes(automation.repairPolicy)) {
    errors.push(`unsupported_automation_repair_policy: ${String(automation.repairPolicy)}`);
  }

  return { errors, warnings };
}

function automationProfileAt(value: unknown): AutomationProfile {
  if (value == null) return "conservative";
  if (automationProfiles.includes(value as AutomationProfile)) return value as AutomationProfile;
  throw new Error(`unsupported_automation_profile: ${String(value)}`);
}

function automationRepairPolicyAt(value: unknown): AutomationRepairPolicy {
  if (value == null) return "conservative";
  if (automationRepairPolicies.includes(value as AutomationRepairPolicy)) return value as AutomationRepairPolicy;
  throw new Error(`unsupported_automation_repair_policy: ${String(value)}`);
}
