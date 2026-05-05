import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RegistryStateStore } from "../src/registry.js";
import { JsonlLogger } from "../src/logging.js";
import { RuntimeStateStore } from "../src/runtime-state.js";
import { getRegistryStatus, inspectIssue } from "../src/status.js";

describe("issue inspection", () => {
  it("shows accepted validation commands and failed historical attempts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "review",
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-01T00:00:00.000Z",
            acceptedCommands: [
              {
                name: "npm run agent-check",
                exitCode: 0,
                startedAt: "2026-05-01T00:01:00.000Z",
                finishedAt: "2026-05-01T00:02:00.000Z"
              }
            ],
            failedHistoricalAttempts: [
              {
                name: "npm run agent-check",
                exitCode: 1,
                startedAt: "2026-05-01T00:00:00.000Z",
                finishedAt: "2026-05-01T00:00:10.000Z"
              }
            ]
          },
          updatedAt: "2026-05-01T00:03:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Validation: passed (final: passed)");
    expect(output).toContain("Accepted validation commands:");
    expect(output).toContain("npm run agent-check: exitCode 0");
    expect(output).toContain("Failed historical attempts:");
    expect(output).toContain("npm run agent-check: exitCode 1");
  });

  it("shows registry project health, CI wait state, daemon freshness, and validation timing splits", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-registry-status-"));
    const repo = join(root, "alpha");
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, "WORKFLOW.md"),
      [
        "---",
        "trust_mode: danger",
        "automation:",
        "  profile: high-throughput",
        "  repair_policy: mechanical-first",
        "lifecycle:",
        "  mode: orchestrator-owned",
        "tracker:",
        "  api_key: lin_test",
        "  project_slug: AgentOS",
        "agent:",
        "  max_concurrent_agents: 2",
        "---",
        "Do work"
      ].join("\n"),
      "utf8"
    );
    const registryPath = join(root, "agent-os.yml");
    await writeFile(
      registryPath,
      ["version: 1", "defaults:", "  maxConcurrency: 2", "projects:", "  - name: alpha", "    repo: ./alpha", "    workflow: WORKFLOW.md", "    maxConcurrency: 1"].join("\n"),
      "utf8"
    );
    await new RegistryStateStore(registryPath).write({
      schemaVersion: 1,
      updatedAt: "2026-05-05T00:10:00.000Z",
      cursor: 0,
      globalConcurrency: 2,
      projects: [
        {
          name: "alpha",
          repoRoot: repo,
          workflowPath: join(repo, "WORKFLOW.md"),
          status: "transient_tracker_error",
          checkedAt: "2026-05-05T00:10:00.000Z",
          activeRuns: 0,
          retryQueue: 0,
          claimedIssues: 0,
          maxConcurrency: 1,
          lastSuccessfulTrackerReadAt: "2026-05-05T00:00:00.000Z",
          lastError: "fetch failed",
          errorCategory: "tracker_network"
        }
      ]
    });
    await new RuntimeStateStore(repo).setDaemon({
      startedAt: "2026-05-05T00:00:00.000Z",
      startGitSha: "old",
      startMainGitSha: "old",
      currentGitSha: "new",
      currentMainGitSha: "new",
      workflowPath: join(repo, "WORKFLOW.md"),
      freshnessStatus: "main_advanced",
      freshnessMessage: "main advanced from old to new; restart required"
    });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "completed",
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-05T00:08:00.000Z",
            acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-05-05T00:06:00.000Z", finishedAt: "2026-05-05T00:07:00.000Z" }],
            additionalPassingCommands: [
              { name: "npm test -- tests/runner.test.ts tests/agent-lifecycle-cli.test.ts", exitCode: 0, startedAt: "2026-05-05T00:03:00.000Z", finishedAt: "2026-05-05T00:04:00.000Z" }
            ],
            failedHistoricalAttempts: [{ name: "npm run agent-check", exitCode: 1, startedAt: "2026-05-05T00:01:00.000Z", finishedAt: "2026-05-05T00:02:00.000Z" }],
            githubCi: { status: "passed", headSha: "abc123", checkedAt: "2026-05-05T00:05:00.000Z" }
          },
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-2.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-2",
          issueIdentifier: "AG-2",
          phase: "completed",
          reviewStatus: "approved",
          prs: [{ url: "https://github.com/o/r/pull/2", role: "primary", source: "handoff", discoveredAt: "2026-05-05T00:00:00.000Z" }],
          updatedAt: "2026-05-05T00:08:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );
    await new JsonlLogger(repo).write({
      type: "merge_waiting",
      issueId: "issue-2",
      issueIdentifier: "AG-2",
      message: "1 GitHub check(s) still pending"
    });

    const output = await getRegistryStatus(registryPath);

    expect(output).toContain("alpha: transient_tracker_error");
    expect(output).toContain("Config: trust=danger; lifecycle=orchestrator-owned; automation=high-throughput/mechanical-first");
    expect(output).toContain("Error: tracker_network - fetch failed");
    expect(output).toContain("Daemon: main_advanced - main advanced from old to new; restart required");
    expect(output).toContain("AG-2: waiting on CI - 1 GitHub check(s) still pending");
    expect(output).toContain("AG-1: local full-suite validation timing failure recorded separately; focused test passed; GitHub CI passed at abc123");
  });
});
