import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateMergeReadiness, GitHubClient, summarizeChecks } from "../src/github.js";

const fixture = resolve("tests/fixtures/fake-gh.mjs");

describe("GitHubClient", () => {
  it("reads pull request status and merges with squash/delete branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          baseRefName: "main",
          headRefName: "agent/AG-1",
          headRefOid: "abc123",
          mergedAt: null,
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
          files: [{ path: "src/github.ts" }],
          reviewDecision: "APPROVED",
          latestReviews: [{ author: { login: "bot" }, state: "APPROVED", body: "Looks good", submittedAt: "2026-01-01T00:00:00Z" }],
          comments: [{ author: { login: "human" }, body: "Thanks", createdAt: "2026-01-01T00:00:00Z" }]
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/1", dir);
    expect(evaluateMergeReadiness(status, true)).toEqual({ ready: true, reason: "ready to merge" });

    await client.mergePullRequest(
      status.url,
      { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false },
      dir
    );

    const state = JSON.parse(await readFile(statePath, "utf8")) as { mergedWith: string[] };
    expect(state.mergedWith).toContain("--squash");
    expect(state.mergedWith).toContain("--delete-branch");
  });

  it("rejects PRs with no checks when checks are required", () => {
    expect(
      evaluateMergeReadiness(
        {
          url: "https://github.com/o/r/pull/2",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          baseRefName: "main",
          headRefName: "agent/AG-2",
          headSha: null,
          merged: false,
          checkSummary: summarizeChecks([]),
          checkDetails: [],
          changedFiles: [],
          reviewDecision: null,
          latestReviews: [],
          comments: []
        },
        true
      )
    ).toEqual({ ready: false, reason: "no GitHub checks are present" });
  });

  it("treats mergedAt from gh as merged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/3",
          state: "MERGED",
          isDraft: false,
          mergeable: null,
          baseRefName: "main",
          headRefName: "agent/AG-3",
          headRefOid: "def456",
          mergedAt: "2026-04-30T10:00:00Z",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/3", dir);

    expect(status.merged).toBe(true);
    expect(evaluateMergeReadiness(status, true)).toEqual({ ready: false, reason: "pull request is already merged" });
  });

  it("summarizes failing and pending checks", () => {
    expect(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "IN_PROGRESS", conclusion: null }
      ])
    ).toEqual({ total: 3, successful: 1, pending: 1, failing: 1 });
  });
});
