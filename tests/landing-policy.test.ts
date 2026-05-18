import { describe, expect, it } from "vitest";
import { evaluateLandingPolicy, evaluateLandingPolicyForConfig } from "../src/landing-policy.js";
import { loadWorkflow, resolveServiceConfig } from "../src/workflow.js";

describe("landing policy", () => {
  it("enables landing when trust, automation, and merge gates are satisfied", () => {
    const result = evaluateLandingPolicy({
      trustMode: "local-trusted",
      automationProfile: "high-throughput",
      githubMergeMode: "shepherd"
    });

    expect(result.status).toBe("enabled");
    expect(result.enabled).toBe(true);
    expect(result.reasons).toEqual([
      "trust_mode=local-trusted permits PR/network and merge",
      "automation.profile=high-throughput",
      "github.merge_mode=shepherd"
    ]);
  });

  it("keeps landing disabled by default", () => {
    const result = evaluateLandingPolicy({
      trustMode: "ci-locked",
      automationProfile: "conservative",
      githubMergeMode: "manual"
    });

    expect(result.status).toBe("disabled");
    expect(result.enabled).toBe(false);
    expect(result.reasons).toContain("github.merge_mode=manual keeps auto-ready and auto-merge disabled");
  });

  it("blocks landing when a requested gate is missing", () => {
    const result = evaluateLandingPolicy({
      trustMode: "ci-locked",
      automationProfile: "high-throughput",
      githubMergeMode: "manual"
    });

    expect(result.status).toBe("blocked");
    expect(result.enabled).toBe(false);
    expect(result.reasons).toContain("trust_mode=ci-locked lacks PR/network or GitHub merge capability");
    expect(result.reasons).toContain("github.merge_mode=manual keeps auto-ready and auto-merge disabled");
  });

  it("keeps the public base workflow template out of landing mode", async () => {
    const workflow = await loadWorkflow("templates/base-harness/WORKFLOW.md");
    const config = resolveServiceConfig(workflow, { LINEAR_API_KEY: "lin_test", HOME: "/tmp" });
    const result = evaluateLandingPolicyForConfig(config);

    expect(config.trustMode).toBe("ci-locked");
    expect(config.automation.profile).toBe("conservative");
    expect(config.github.mergeMode).toBe("manual");
    expect(result.status).toBe("disabled");
  });
});
