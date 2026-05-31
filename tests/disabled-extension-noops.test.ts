import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHttpServerIfConfigured } from "../src/http-server-cli.js";
import { selectModelRoute } from "../src/model-routing.js";
import { Orchestrator } from "../src/orchestrator.js";
import { runReviewFixerCiRepair, type ReviewFixerCiPostValidationExtensionDeps } from "../src/post-validation-review-adapter.js";
import type { AgentRunResult, IssueState } from "../src/types.js";
import { fakeIssue, fakeServiceConfig, strictAgentOwnedLifecycleYaml } from "./fixtures/agentos-fakes.js";
import type { SchedulerSafetyWriter, TrackerReader } from "../src/tracker-boundaries.js";

describe("disabled extension no-ops", () => {
  it("does not build reviewer or fixer prompts when review is disabled", async () => {
    const issue = fakeIssue();
    const state: IssueState = {
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      outcome: "implemented",
      prs: [{ url: "https://github.com/o/r/pull/1", role: "primary", source: "handoff", discoveredAt: "2026-05-31T00:00:00.000Z" }],
      updatedAt: "2026-05-31T00:00:00.000Z"
    };
    const fail = async (): Promise<never> => {
      throw new Error("disabled review must not start reviewer/fixer side effects");
    };
    const deps: ReviewFixerCiPostValidationExtensionDeps = {
      repoRoot: process.cwd(),
      config: () => fakeServiceConfig({ review: { ...fakeServiceConfig().review, enabled: false } }),
      runner: () => ({ run: fail }),
      logger: { write: fail } as unknown as ReviewFixerCiPostValidationExtensionDeps["logger"],
      recordIssueState: fail,
      commentIssue: fail,
      startRunPhase: fail,
      finishRunPhase: fail,
      recordContextBudget: fail,
      writeRunEvent: fail,
      markRunningActivity() {
        throw new Error("disabled review must not mark reviewer/fixer activity");
      }
    };

    await expect(
      runReviewFixerCiRepair(deps, {
        issue,
        workspace: { path: process.cwd(), workspaceKey: issue.identifier, createdNow: false },
        state,
        attempt: 0,
        runId: "run-disabled-review"
      })
    ).resolves.toBe(state);
  });

  it("does not run the merge shepherd when github.merge_mode is manual", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-disabled-manual-merge-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\n${strictAgentOwnedLifecycleYaml}\ntracker:\n  kind: linear\n  api_key: lin_test\n  project_slug: AgentOS\n  active_states: [Ready]\n  merge_state: Merging\nworkspace:\n  root: .agent-os/workspaces\ngithub:\n  merge_mode: manual\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const queriedStates: string[][] = [];
    const tracker: TrackerReader = {
      async fetchCandidates(states) {
        queriedStates.push(states);
        if (states.includes("Merging")) throw new Error("manual merge must not fetch merge-state candidates");
        return [];
      },
      async fetchIssueStates() {
        return new Map();
      }
    };

    await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("manual merge no-op proof should not dispatch a runner");
        }
      },
      env: { HOME: "/tmp" }
    }).runOnce(true);

    expect(queriedStates).toEqual([["Ready"]]);
  });

  it("does not start the monitor server or control API when the monitor is disabled", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-disabled-monitor-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\ntracker:\n  kind: linear\n  api_key: lin_test\n  project_slug: AgentOS\nworkspace:\n  root: .agent-os/workspaces\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const monitor = {
      snapshot(): never {
        throw new Error("disabled monitor server must not read monitor state");
      },
      subscribe(): never {
        throw new Error("disabled monitor server must not subscribe to monitor state");
      }
    };

    await expect(startHttpServerIfConfigured({ repoRoot: repo, workflowPath, monitor })).resolves.toBeNull();
  });

  it("keeps report-only model routing from applying a model override", () => {
    const route = selectModelRoute(
      {
        mode: "report-only",
        roles: {
          "tests-review": {
            model: "gpt-5.4-mini",
            reasoningEffort: "low",
            costBucket: "low"
          }
        }
      },
      { role: "tests-review", reviewer: "tests" }
    );

    expect(route).toMatchObject({
      mode: "report-only",
      configured: true,
      applied: false,
      model: "inherited",
      reasoningEffort: null,
      proposedModel: "gpt-5.4-mini",
      proposedReasoningEffort: "low"
    });
  });

  it("keeps planning-disabled guardrails from exposing a child-issue writer", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-disabled-planning-writer-"));
    const workflowPath = join(repo, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---\n${strictAgentOwnedLifecycleYaml}\ntracker:\n  kind: linear\n  api_key: lin_test\n  project_slug: AgentOS\n  active_states: [Ready]\n  needs_input_state: Human Review\nagent:\n  max_turns: 1\nworkspace:\n  root: .agent-os/workspaces\nreview:\n  enabled: false\n---\nDo {{ issue.identifier }}`,
      "utf8"
    );
    const broadIssue = fakeIssue({
      title: "Add orchestration report across Linear GitHub runtime validation docs and workspaces",
      description: [
        "Roadmap item for broad orchestrator observability.",
        "- Audit Linear lifecycle state.",
        "- Inspect GitHub pull request state.",
        "- Read runtime state and run events.",
        "- Include validation and handoff evidence.",
        "- Estimate docs and tests impact.",
        "- Surface workspace recovery and branch state."
      ].join("\n")
    });
    const touchedWriters: string[] = [];
    const tracker = {
      async fetchCandidates() {
        return [broadIssue];
      },
      async fetchIssueStates() {
        return new Map([[broadIssue.id, broadIssue]]);
      }
    } as TrackerReader & Record<string, unknown>;
    for (const method of ["createIssue", "updateIssue", "createIssueRelation"] as const) {
      Object.defineProperty(tracker, method, {
        get() {
          touchedWriters.push(method);
          throw new Error(`planning-disabled core exposed writer method: ${method}`);
        }
      });
    }
    const schedulerSafetyWriter: SchedulerSafetyWriter = {
      async upsertComment() {
        return "created";
      },
      async move() {}
    };

    const result = await new Orchestrator({
      repoRoot: repo,
      workflowPath,
      tracker,
      schedulerSafetyWriter,
      agentLifecycleWriter: {},
      runner: {
        async run(): Promise<AgentRunResult> {
          throw new Error("planning guardrail must stop before implementation dispatch");
        }
      },
      env: { HOME: "/tmp" }
    }).runOnce(true);

    expect(result.dispatched).toBe(0);
    expect(touchedWriters).toEqual([]);
  });
});
