import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { getRegistryStatus, inspectIssue } from "../src/status.js";
import { JsonlLogger } from "../src/logging.js";
import { writeReviewArtifact } from "../src/review.js";
import type { AgentRunResult, AgentRunner, IssueTracker } from "../src/types.js";
import { fakeIssue, writePassingHandoff } from "./fixtures/agentos-fakes.js";

const fakeGh = resolve("tests/fixtures/fake-gh.mjs");
const readyIssue = fakeIssue({ state: "Ready" });

describe("reviewer artifact retry", () => {
  it("retries a missing reviewer artifact and preserves the approved result", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self"], maxRetryAttempts: 1 });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      const count = increment(attempts, reviewer);
      if (count === 1) return { status: "succeeded" };
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(attempts.get("self")).toBe(2);
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewRunnerFailures).toEqual([
      expect.objectContaining({ reviewer: "self", reason: "missing_artifact", retryable: true })
    ]);
  });

  it("retries malformed reviewer JSON narrowly", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self"], maxRetryAttempts: 1 });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      const count = increment(attempts, reviewer);
      if (count === 1) {
        await writeFile(join(input.workspace.path, artifactPath), "{ not json", "utf8");
        return { status: "succeeded" };
      }
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(attempts.get("self")).toBe(2);
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewRunnerFailures[0]).toEqual(expect.objectContaining({ reason: "malformed_artifact", retryable: true }));
  });

  it("retries a stalled reviewer runner when the artifact is untrusted", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self"], maxRetryAttempts: 1 });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      const count = increment(attempts, reviewer);
      if (count === 1) return { status: "stalled", error: "stall timeout exceeded" };
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(attempts.get("self")).toBe(2);
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewRunnerFailures[0]).toEqual(expect.objectContaining({ reason: "runner_stalled", retryable: true, resultStatus: "stalled" }));
  });

  it("retries only the failed reviewer and reuses successful reviewer artifacts", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self", "correctness"], maxRetryAttempts: 1 });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      const count = increment(attempts, reviewer);
      if (reviewer === "correctness" && count === 1) return { status: "succeeded" };
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(attempts.get("self")).toBe(1);
    expect(attempts.get("correctness")).toBe(2);
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewers.map((reviewer: { name: string; decision: string }) => [reviewer.name, reviewer.decision])).toEqual([
      ["self", "approved"],
      ["correctness", "approved"]
    ]);
  });

  it("escalates after reviewer-specific retry exhaustion without treating P3 advisories as fix-triggering blockers", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self", "correctness"], maxRetryAttempts: 1 });
    let fixRuns = 0;

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      if (input.prompt.startsWith("You are fixing")) {
        fixRuns += 1;
        return { status: "succeeded" };
      }
      if (reviewer === "self") {
        await writeReviewArtifact(join(input.workspace.path, artifactPath), {
          reviewer,
          decision: "approved",
          summary: "non-blocking advisory",
          findings: [
            {
              reviewer,
              decision: "approved",
              severity: "P3",
              file: "src/orchestrator.ts",
              line: 1,
              body: "Consider a follow-up cleanup.",
              findingHash: "p3-advisory"
            }
          ]
        });
      }
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(fixRuns).toBe(0);
    expect(state.reviewStatus).toBe("human_required");
    expect(state.findings).toEqual([expect.objectContaining({ severity: "P3", findingHash: "p3-advisory" })]);
    expect(state.reviewRunnerFailures.at(-1)).toEqual(expect.objectContaining({ reviewer: "correctness", exhausted: true }));
    expect(scenario.comments.join("\n")).toContain("Reviewer runner failures:");
    expect(scenario.comments.join("\n")).toContain("retry budget exhausted");
    expect(scenario.comments.join("\n")).toContain("Blocking findings:\nNo findings.");

    const inspectOutput = await inspectIssue(scenario.repo, "AG-1");
    expect(inspectOutput).toContain("Review runner failures:");
    expect(inspectOutput).toContain("correctness iteration 1 attempt 2/2");

    await writeFile(
      join(scenario.repo, "agent-os.yml"),
      ["version: 1", "projects:", "  - name: local", "    repo: .", "    workflow: WORKFLOW.md"].join("\n"),
      "utf8"
    );
    const registryStatus = await getRegistryStatus(join(scenario.repo, "agent-os.yml"));
    expect(registryStatus).toContain("reviewer runner failure (correctness: missing_artifact)");
  });

  it("escalates non-mechanical reviewer failures without consuming the artifact retry budget", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self"], maxRetryAttempts: 3 });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ reviewer }) => {
      increment(attempts, reviewer);
      return { status: "failed", error: "codex_user_input_request_denied: reviewer requested input" };
    });

    const state = await scenario.readState();
    expect(attempts.get("self")).toBe(1);
    expect(state.reviewStatus).toBe("human_required");
    expect(state.reviewRunnerFailures).toEqual([
      expect.objectContaining({ classification: "non_mechanical", reason: "human_input_required", retryable: false })
    ]);
  });
});

async function setupReviewScenario(options: { requiredReviewers: string[]; maxRetryAttempts: number }): Promise<{
  repo: string;
  comments: string[];
  run: (onReview: (input: { input: Parameters<AgentRunner["run"]>[0]; reviewer: string; artifactPath: string }) => Promise<AgentRunResult>) => Promise<void>;
  readState: () => Promise<Record<string, any>>;
}> {
  const repo = await mkdtemp(join(tmpdir(), "agent-os-review-retry-"));
  await initGitRemote(repo);
  const workflowPath = join(repo, "WORKFLOW.md");
  const ghState = join(repo, "gh-state.json");
  await writeFile(
    workflowPath,
    [
      "---",
      "tracker:",
      "  kind: linear",
      "  api_key: $LINEAR_API_KEY",
      "  project_slug: AgentOS",
      "  active_states: [Ready]",
      "  running_state: In Progress",
      "  review_state: Human Review",
      "agent:",
      `  max_retry_attempts: ${options.maxRetryAttempts}`,
      "workspace:",
      "  root: .agent-os/workspaces",
      "github:",
      `  command: GH_FAKE_STATE=${JSON.stringify(ghState)} node ${JSON.stringify(fakeGh)}`,
      "review:",
      "  enabled: true",
      "  max_iterations: 1",
      `  required_reviewers: [${options.requiredReviewers.join(", ")}]`,
      "  optional_reviewers: []",
      "---",
      "Do {{ issue.identifier }}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    ghState,
    JSON.stringify(
      {
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/orchestrator.ts" }]
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const comments: string[] = [];
  const tracker: IssueTracker = {
    async fetchCandidates() {
      return [readyIssue];
    },
    async fetchIssueStates() {
      return new Map([[readyIssue.id, readyIssue]]);
    },
    async move() {},
    async comment(_issue, body) {
      comments.push(body);
    }
  };

  return {
    repo,
    comments,
    async run(onReview) {
      const runner: AgentRunner = {
        async run(input): Promise<AgentRunResult> {
          if (input.prompt.startsWith("Do ")) {
            await writePassingHandoff(input.workspace, "AG-1", input.prompt, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
            return { status: "succeeded" };
          }
          if (input.prompt.startsWith("You are fixing")) {
            return onReview({ input, reviewer: "fixer", artifactPath: "" });
          }
          const artifactPath = input.prompt.match(/Write exactly one JSON file at:\n(.+)/)?.[1]?.trim();
          const reviewer = input.prompt.match(/You are the (.+) automated reviewer/)?.[1] ?? "self";
          if (!artifactPath) return { status: "failed", error: "missing artifact path" };
          return onReview({ input, reviewer, artifactPath });
        }
      };
      await new Orchestrator({
        repoRoot: repo,
        workflowPath,
        tracker,
        runner,
        logger: new JsonlLogger(repo),
        env: { LINEAR_API_KEY: "lin_test", HOME: "/tmp" }
      }).runOnce(true);
    },
    async readState() {
      return JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    }
  };
}

async function writeApprovedArtifact(workspacePath: string, artifactPath: string, reviewer: string): Promise<void> {
  await writeReviewArtifact(join(workspacePath, artifactPath), {
    reviewer,
    decision: "approved",
    summary: "approved",
    findings: []
  });
}

function increment(counts: Map<string, number>, key: string): number {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  return next;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `${command} failed`));
    });
  });
}

async function initGitRemote(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await run("git", ["init"], repo);
  await run("git", ["remote", "add", "origin", "https://github.com/o/r.git"], repo);
}
