import { describe, expect, it } from "vitest";
import { defaultModelRoutingConfig, modelTelemetry, parseModelRoutingConfig, selectModelRoute } from "../src/model-routing.js";

describe("model routing", () => {
  it("keeps default routing as an inherited no-op", () => {
    expect(selectModelRoute(defaultModelRoutingConfig(), { role: "implementation" })).toMatchObject({
      role: "implementation",
      mode: "off",
      applied: false,
      configured: false,
      model: "inherited",
      costBucket: "inherited"
    });
  });

  it("applies an explicitly configured cheaper reviewer role", () => {
    const config = parseModelRoutingConfig({
      mode: "apply",
      roles: {
        "tests-review": {
          model: "gpt-5.4-mini",
          reasoning_effort: "low",
          cost_bucket: "low"
        }
      }
    });

    expect(selectModelRoute(config, { role: "tests-review", reviewer: "tests" })).toMatchObject({
      applied: true,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      costBucket: "low"
    });
  });

  it("promotes after malformed artifacts instead of repeating the cheaper route", () => {
    const config = parseModelRoutingConfig({
      mode: "apply",
      roles: {
        "self-review": {
          model: "gpt-5.4-mini",
          promote_to_model: "gpt-5.5",
          promote_reasoning_effort: "high"
        }
      }
    });

    expect(selectModelRoute(config, { role: "self-review", artifactFailure: "malformed_artifact", attempt: 2 })).toMatchObject({
      applied: false,
      model: "gpt-5.5",
      reasoningEffort: "high",
      escalationReason: "malformed_artifact"
    });
  });

  it("refuses downgrade for security and recovery-sensitive scopes", () => {
    const config = parseModelRoutingConfig({
      mode: "apply",
      roles: {
        "security-review": { model: "gpt-5.4-mini", cost_bucket: "low" },
        "tests-review": { model: "gpt-5.4-mini", cost_bucket: "low" }
      }
    });

    expect(selectModelRoute(config, { role: "security-review" })).toMatchObject({
      applied: false,
      refusedReason: "high_capability_or_sensitive_scope"
    });
    expect(selectModelRoute(config, { role: "tests-review", risk: ["restart recovery"] })).toMatchObject({
      applied: false,
      refusedReason: "high_capability_or_sensitive_scope"
    });
  });

  it("records elapsed time, token usage, role, and cost bucket as telemetry", () => {
    const decision = selectModelRoute(parseModelRoutingConfig({ mode: "report-only", roles: { "tests-review": { model: "gpt-5.4-mini", cost_bucket: "low" } } }), { role: "tests-review" });

    expect(modelTelemetry(decision, { elapsedMs: 42, inputTokens: 10, outputTokens: 5, totalTokens: 15, recordedAt: "2026-05-22T00:00:00.000Z" })).toMatchObject({
      role: "tests-review",
      mode: "report-only",
      applied: false,
      proposedModel: "gpt-5.4-mini",
      elapsedMs: 42,
      tokenUsage: { input: 10, output: 5, total: 15 },
      costBucket: "low"
    });
  });
});
