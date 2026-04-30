import { describe, expect, it } from "vitest";
import { defaultThreadSandboxForTrustMode, defaultTurnSandboxPolicyForTrustMode, parseGitHubMergeMode, parseTrustMode, trustCapabilities, validateTrustCompatibility } from "../src/trust.js";

describe("trust modes", () => {
  it("defines the capability matrix", () => {
    expect(trustCapabilities("review-only")).toMatchObject({
      network: false,
      repoWrite: false,
      reviewWrite: true,
      prNetwork: false,
      githubMerge: false,
      codexUserInput: "deny"
    });
    expect(trustCapabilities("local-trusted")).toMatchObject({
      network: true,
      repoWrite: true,
      prNetwork: true,
      githubMerge: true,
      codexUserInput: "deny"
    });
    expect(trustCapabilities("danger").codexUserInput).toBe("allow");
  });

  it("parses supported modes and rejects unknown values", () => {
    expect(parseTrustMode(undefined)).toBe("ci-locked");
    expect(parseTrustMode("local-trusted")).toBe("local-trusted");
    expect(() => parseTrustMode("unbounded")).toThrow("unsupported_trust_mode: unbounded");
    expect(parseGitHubMergeMode(undefined)).toBe("manual");
    expect(parseGitHubMergeMode("shepherd")).toBe("shepherd");
    expect(() => parseGitHubMergeMode("force")).toThrow("unsupported_github_merge_mode: force");
  });

  it("chooses sandbox defaults from trust mode", () => {
    expect(defaultThreadSandboxForTrustMode("review-only")).toBe("read-only");
    expect(defaultTurnSandboxPolicyForTrustMode("ci-locked")).toEqual({ type: "workspaceWrite", networkAccess: false });
    expect(defaultTurnSandboxPolicyForTrustMode("local-trusted")).toEqual({ type: "workspaceWrite", networkAccess: true });
  });

  it("blocks PR and network settings that exceed the trust mode", () => {
    expect(
      validateTrustCompatibility({
        trustMode: "ci-locked",
        githubMergeMode: "shepherd",
        turnSandboxPolicy: { type: "workspaceWrite", networkAccess: true },
        reviewEnabled: true
      })
    ).toEqual({
      errors: [
        "codex.turn_sandbox_policy.networkAccess=true is incompatible with trust_mode=ci-locked",
        "github.merge_mode=shepherd requires a trust mode with GitHub merge capability",
        "github.merge_mode=shepherd requires PR/network capability"
      ],
      warnings: ["trust_mode=ci-locked disables PR/network access; automated PR review context may be unavailable"]
    });
  });

  it("blocks interactive Codex event policies outside danger mode", () => {
    expect(
      validateTrustCompatibility({
        trustMode: "local-trusted",
        githubMergeMode: "manual",
        turnSandboxPolicy: { type: "workspaceWrite", networkAccess: true },
        approvalEventPolicy: "allow",
        userInputPolicy: "allow"
      }).errors
    ).toEqual([
      "codex.approval_event_policy=allow requires trust_mode=danger",
      "codex.user_input_policy=allow requires a trust mode with Codex user input capability"
    ]);
  });
});
