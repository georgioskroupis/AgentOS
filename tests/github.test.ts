import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateMergeReadiness, GitHubClient, summarizeCheckDiagnostics, summarizeChecks } from "../src/github.js";

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

  it("refuses to read Actions logs from a check URL outside the reviewed repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/4",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "third-party",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/evil/repo/actions/runs/123"
            }
          ]
        },
        runLogs: {
          "123": "npm run agent-check\nsrc/github.ts(1,1): error TS2304: Cannot find name 'leaked'."
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/4", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].classification).toBe("human_required");
    expect(diagnostics[0].log).toBeNull();
    expect(diagnostics[0].reason).toContain("reviewed pull request repository");
  });

  it("refuses to read Actions logs when the run head SHA does not match the PR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/6",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/789"
            }
          ]
        },
        runViews: {
          "789": { headSha: "different-sha" }
        },
        runLogs: {
          "789": "npm run agent-check\nsrc/github.ts(1,1): error TS2304: Cannot find name 'leaked'."
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/6", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].classification).toBe("human_required");
    expect(diagnostics[0].log).toBeNull();
    expect(diagnostics[0].reason).toContain("head SHA");
  });

  it("redacts and bounds failed Actions log excerpts before summarizing diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    const secret = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/5",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/456"
            }
          ]
        },
        runLogs: {
          "456": `npm test\nTOKEN=${secret}\nAssertionError: expected 1 to be 2\n${"x".repeat(5000)}`
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/5", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);
    const summary = summarizeCheckDiagnostics(diagnostics);

    expect(diagnostics[0].classification).toBe("mechanical");
    expect(diagnostics[0].log?.length).toBeLessThanOrEqual(4000);
    expect(summary).toContain("sanitized, untrusted");
    expect(summary).toContain("[REDACTED]");
    expect(summary).not.toContain(secret);
    expect(summary.length).toBeLessThan(1500);
  });
});
