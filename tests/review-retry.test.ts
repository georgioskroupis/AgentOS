import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

  it("runs opt-in reviewers in parallel with a concurrency cap and deterministic ordering", async () => {
    const scenario = await setupReviewScenario({
      requiredReviewers: ["self", "correctness", "tests"],
      maxRetryAttempts: 1,
      parallelReviewers: true,
      maxConcurrentReviewers: 2
    });
    const started: string[] = [];
    const completed: string[] = [];
    const writableRoots: string[] = [];
    let active = 0;
    let maxActive = 0;

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(reviewer);
      const policy = input.config.codex.turnSandboxPolicy as { writableRoots?: string[] };
      writableRoots.push(policy.writableRoots?.[0] ?? "");
      await delay(reviewer === "self" ? 30 : reviewer === "correctness" ? 5 : 10);
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      completed.push(reviewer);
      active -= 1;
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(maxActive).toBe(2);
    expect(new Set(started)).toEqual(new Set(["self", "correctness", "tests"]));
    expect(completed[0]).toBe("correctness");
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewers.map((reviewer: { name: string }) => reviewer.name)).toEqual(["self", "correctness", "tests"]);
    expect(new Set(writableRoots).size).toBe(3);
    expect(writableRoots).toEqual(
      expect.arrayContaining([
        join(scenario.repo, ".agent-os", "workspaces", "AG-1", ".agent-os", "reviews", "AG-1", "iteration-1", "self"),
        join(scenario.repo, ".agent-os", "workspaces", "AG-1", ".agent-os", "reviews", "AG-1", "iteration-1", "correctness"),
        join(scenario.repo, ".agent-os", "workspaces", "AG-1", ".agent-os", "reviews", "AG-1", "iteration-1", "tests")
      ])
    );
  });

  it("keeps conservative reviewer runs on the sequential path", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self", "correctness"], maxRetryAttempts: 1 });
    const artifactPaths: string[] = [];
    let active = 0;
    let maxActive = 0;

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      artifactPaths.push(artifactPath);
      await delay(5);
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      active -= 1;
      return { status: "succeeded" };
    });

    expect(maxActive).toBe(1);
    expect(artifactPaths).toEqual([
      join(".agent-os", "reviews", "AG-1", "iteration-1", "self.json"),
      join(".agent-os", "reviews", "AG-1", "iteration-1", "correctness.json")
    ]);
  });

  it("retries one failed parallel reviewer narrowly while preserving successful artifacts", async () => {
    const scenario = await setupReviewScenario({
      requiredReviewers: ["self", "correctness"],
      maxRetryAttempts: 1,
      parallelReviewers: true,
      maxConcurrentReviewers: 2
    });
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
    expect(state.reviewRunnerFailures).toEqual([expect.objectContaining({ reviewer: "correctness", reason: "missing_artifact", retryable: true })]);
    expect(state.reviewers.map((reviewer: { name: string }) => reviewer.name)).toEqual(["self", "correctness"]);
  });

  it("aggregates blocking parallel findings in configured reviewer order", async () => {
    const scenario = await setupReviewScenario({
      requiredReviewers: ["self", "correctness"],
      maxRetryAttempts: 1,
      parallelReviewers: true,
      maxConcurrentReviewers: 2,
      maxIterations: 1
    });

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      await delay(reviewer === "self" ? 20 : 1);
      await writeReviewArtifact(join(input.workspace.path, artifactPath), {
        reviewer,
        decision: "changes_requested",
        summary: "fix required",
        findings: [
          {
            reviewer,
            decision: "changes_requested",
            severity: "P1",
            file: "src/orchestrator.ts",
            line: reviewer === "self" ? 10 : 20,
            body: `${reviewer} found a blocking issue.`,
            findingHash: `${reviewer}-blocking`
          }
        ]
      });
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(state.reviewStatus).toBe("human_required");
    expect(state.findings.map((finding: { reviewer: string; findingHash: string }) => [finding.reviewer, finding.findingHash])).toEqual([
      ["self", "self-blocking"],
      ["correctness", "correctness-blocking"]
    ]);
  });

  it("runs optional security reviewer in parallel when changed files require it", async () => {
    const scenario = await setupReviewScenario({
      requiredReviewers: ["self"],
      optionalReviewers: ["security"],
      maxRetryAttempts: 1,
      parallelReviewers: true,
      maxConcurrentReviewers: 2,
      changedFiles: ["src/auth/session.ts"]
    });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      increment(attempts, reviewer);
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(attempts.get("security")).toBe(1);
    expect(state.reviewStatus).toBe("approved");
    expect(state.reviewers.map((reviewer: { name: string }) => reviewer.name)).toEqual(["self", "security"]);
  });

  it("can skip optional reviewers after a blocking required-reviewer signal", async () => {
    const scenario = await setupReviewScenario({
      requiredReviewers: ["self"],
      optionalReviewers: ["security"],
      maxRetryAttempts: 1,
      parallelReviewers: true,
      maxConcurrentReviewers: 2,
      skipOptionalReviewersAfterBlockingRequired: true,
      changedFiles: ["src/auth/session.ts"],
      maxIterations: 1
    });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      increment(attempts, reviewer);
      await writeReviewArtifact(join(input.workspace.path, artifactPath), {
        reviewer,
        decision: "changes_requested",
        summary: "fix required",
        findings: [
          {
            reviewer,
            decision: "changes_requested",
            severity: "P1",
            file: "src/orchestrator.ts",
            line: 10,
            body: "Required reviewer found enough blocking signal.",
            findingHash: "self-blocking"
          }
        ]
      });
      return { status: "succeeded" };
    });

    const state = await scenario.readState();
    expect(attempts.get("self")).toBe(1);
    expect(attempts.has("security")).toBe(false);
    expect(state.reviewers.map((reviewer: { name: string }) => reviewer.name)).toEqual(["self"]);
    expect(state.findings).toEqual([expect.objectContaining({ reviewer: "self", findingHash: "self-blocking" })]);
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

  it("escalates non-mechanical reviewer failures even when a fresh artifact exists", async () => {
    const scenario = await setupReviewScenario({ requiredReviewers: ["self"], maxRetryAttempts: 3 });
    const attempts = new Map<string, number>();

    await scenario.run(async ({ input, reviewer, artifactPath }) => {
      increment(attempts, reviewer);
      await writeApprovedArtifact(input.workspace.path, artifactPath, reviewer);
      return { status: "failed", error: "codex_user_input_request_denied: reviewer requested input" };
    });

    const state = await scenario.readState();
    expect(attempts.get("self")).toBe(1);
    expect(state.reviewStatus).toBe("human_required");
    expect(state.reviewers).toEqual([expect.objectContaining({ name: "self", decision: "human_required" })]);
    expect(state.reviewRunnerFailures).toEqual([
      expect.objectContaining({
        classification: "non_mechanical",
        reason: "human_input_required",
        resultStatus: "failed",
        retryable: false
      })
    ]);

    const canonicalArtifact = JSON.parse(await readFile(join(scenario.repo, ".agent-os", "reviews", "AG-1", "iteration-1", "self.json"), "utf8"));
    expect(canonicalArtifact.decision).toBe("human_required");
    expect(canonicalArtifact.findings[0].body).toContain("codex_user_input_request_denied");
  });
});

async function setupReviewScenario(options: {
  requiredReviewers: string[];
  maxRetryAttempts: number;
  optionalReviewers?: string[];
  parallelReviewers?: boolean;
  maxConcurrentReviewers?: number;
  skipOptionalReviewersAfterBlockingRequired?: boolean;
  changedFiles?: string[];
  maxIterations?: number;
}): Promise<{
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
      `  max_iterations: ${options.maxIterations ?? 1}`,
      ...(options.parallelReviewers == null ? [] : [`  parallel_reviewers: ${options.parallelReviewers ? "true" : "false"}`]),
      ...(options.maxConcurrentReviewers == null ? [] : [`  max_concurrent_reviewers: ${options.maxConcurrentReviewers}`]),
      ...(options.skipOptionalReviewersAfterBlockingRequired == null ? [] : [`  skip_optional_reviewers_after_blocking_required: ${options.skipOptionalReviewersAfterBlockingRequired ? "true" : "false"}`]),
      `  required_reviewers: [${options.requiredReviewers.join(", ")}]`,
      `  optional_reviewers: [${(options.optionalReviewers ?? []).join(", ")}]`,
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
          files: (options.changedFiles ?? ["src/orchestrator.ts"]).map((path) => ({ path }))
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
