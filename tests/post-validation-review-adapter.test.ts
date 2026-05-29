import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlLogger } from "../src/logging.js";
import { createReviewFixerCiPostValidationExtension } from "../src/post-validation-review-adapter.js";
import type { AgentRunResult, AgentRunner, Issue, IssueState } from "../src/types.js";
import { fakeIssue, fakeServiceConfig } from "./fixtures/agentos-fakes.js";

describe("review/fixer/CI post-validation extension", () => {
  it("is a no-op when review is disabled", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-review-extension-disabled-"));
    const issue = fakeIssue();
    const state = issueState(issue, "https://github.com/o/r/pull/1");
    const extension = createReviewFixerCiPostValidationExtension({
      repoRoot: repo,
      config: () => fakeServiceConfig({ review: { ...fakeServiceConfig().review, enabled: false } }),
      runner: () => throwingRunner(),
      logger: new JsonlLogger(repo),
      recordIssueState: async () => {
        throw new Error("disabled review must not write issue state");
      },
      commentIssue: async () => {
        throw new Error("disabled review must not comment");
      },
      startRunPhase: async () => {
        throw new Error("disabled review must not start review timing");
      },
      finishRunPhase: async () => {
        throw new Error("disabled review must not finish review timing");
      },
      recordContextBudget: async () => {
        throw new Error("disabled review must not budget fixer prompts");
      },
      writeRunEvent: async () => {
        throw new Error("disabled review must not emit review events");
      },
      markRunningActivity: () => {
        throw new Error("disabled review must not observe runner activity");
      }
    });

    await expect(extension.afterValidation({ issue, workspace: { path: repo, workspaceKey: "AG-1", createdNow: true }, state, attempt: 0, runId: "run_1" })).resolves.toBe(state);
  });

  it("records a review extension failure when PR metadata has no selected target", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-review-extension-target-"));
    const issue = fakeIssue();
    let persisted = issueState(issue, "https://github.com/o/r/pull/2", "supporting");
    const comments: string[] = [];
    const phases: string[] = [];
    const extension = createReviewFixerCiPostValidationExtension({
      repoRoot: repo,
      config: () => fakeServiceConfig({ review: { ...fakeServiceConfig().review, enabled: true, maxIterations: 1, requiredReviewers: ["self"], optionalReviewers: [] } }),
      runner: () => throwingRunner(),
      logger: new JsonlLogger(repo),
      recordIssueState: async (_issue, patch) => {
        persisted = { ...persisted, ...patch, updatedAt: "2026-01-01T00:00:00.000Z" };
        return persisted;
      },
      commentIssue: async (_issue, body) => {
        comments.push(body);
      },
      startRunPhase: async (_runId, _issue, phase) => {
        phases.push(`start:${phase}`);
        return { id: "phase-1", phase, status: "running", startedAt: "2026-01-01T00:00:00.000Z" };
      },
      finishRunPhase: async (_runId, _issue, timing, status, metadata) => {
        phases.push(`finish:${timing.phase}:${status}:${String(metadata?.reviewStatus)}`);
      },
      recordContextBudget: async () => {
        throw new Error("target-selection failure must not build a fixer prompt");
      },
      writeRunEvent: async () => undefined,
      markRunningActivity: () => undefined
    });

    const result = await extension.afterValidation({ issue, workspace: { path: repo, workspaceKey: "AG-1", createdNow: true }, state: persisted, attempt: 0, runId: "run_1" });

    expect(result).toMatchObject({
      reviewStatus: "human_required",
      reviewTargetUrls: [],
      errorCategory: "review"
    });
    expect(result?.lastError).toContain("no merge-eligible PR was recorded");
    expect(comments.join("\n")).toContain("could not select a pull request target");
    expect(phases).toEqual(["start:automated-review", "finish:automated-review:failed:human_required"]);
  });
});

function issueState(issue: Issue, url: string, role: "primary" | "supporting" = "primary"): IssueState {
  return {
    schemaVersion: 1,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    outcome: "implemented",
    phase: "completed",
    prs: [{ url, role }],
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function throwingRunner(): AgentRunner {
  return {
    async run(): Promise<AgentRunResult> {
      throw new Error("review extension test did not expect runner invocation");
    }
  };
}
