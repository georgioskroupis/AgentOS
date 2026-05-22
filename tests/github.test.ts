import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateMergeReadiness, GitHubClient, summarizeCheckDiagnostics, summarizeChecks, verifyGitHubCli } from "../src/github.js";

const fixture = resolve("tests/fixtures/fake-gh.mjs");

describe("GitHubClient", () => {
  it("redacts GitHub auth status failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-auth-"));
    const statePath = join(dir, "state.json");
    const secret = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
    await writeFile(statePath, JSON.stringify({ authError: `GH_TOKEN=${secret} authentication failed` }), "utf8");

    const result = await verifyGitHubCli(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`, dir);

    expect(result.ok).toBe(false);
    expect(result.details).toContain("[REDACTED]");
    expect(result.details).not.toContain(secret);
  });

  it("reads pull request status and merges without branch deletion side effects", async () => {
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
      { command: "gh", mergeMode: "manual", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false, baseBranch: "main" },
      dir
    );

    const state = JSON.parse(await readFile(statePath, "utf8")) as { mergedWith: string[] };
    expect(state.mergedWith).toContain("--squash");
    expect(state.mergedWith).not.toContain("--delete-branch");
  });

  it("updates a pull request branch through the GitHub CLI boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-update-branch-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/4",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
          baseRefName: "main",
          headRefName: "agent/AG-4",
          headRepository: { owner: { login: "o" }, name: "r" },
          isCrossRepository: false,
          headRefOid: "old-head",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
        },
        afterUpdateView: {
          url: "https://github.com/o/r/pull/4",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          baseRefName: "main",
          headRefName: "agent/AG-4",
          headRepository: { owner: { login: "o" }, name: "r" },
          isCrossRepository: false,
          headRefOid: "new-head",
          statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS", conclusion: null }]
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    await client.updatePullRequestBranch("https://github.com/o/r/pull/4", dir);
    const status = await client.getPullRequest("https://github.com/o/r/pull/4", dir);
    const state = JSON.parse(await readFile(statePath, "utf8"));

    expect(state.updatedBranches).toEqual([{ target: "https://github.com/o/r/pull/4", args: [] }]);
    expect(status.headSha).toBe("new-head");
    expect(status.mergeStateStatus).toBe("CLEAN");
    expect(status.checkSummary.pending).toBe(1);
  });

  it("marks a draft pull request ready through the GitHub CLI boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-ready-pr-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/5",
          state: "OPEN",
          isDraft: true,
          mergeable: "MERGEABLE",
          headRefOid: "head-ready",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    await client.markPullRequestReady("https://github.com/o/r/pull/5", dir);
    const status = await client.getPullRequest("https://github.com/o/r/pull/5", dir);
    const state = JSON.parse(await readFile(statePath, "utf8"));

    expect(state.readyPrs).toEqual([{ target: "https://github.com/o/r/pull/5", args: [] }]);
    expect(status.isDraft).toBe(false);
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
          headRepository: null,
          isCrossRepository: null,
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

  it("does not diagnose successful legacy status contexts as failing checks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/7",
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
            },
            {
              context: "legacy/status",
              state: "SUCCESS",
              targetUrl: "https://github.com/o/r/actions/runs/999"
            }
          ]
        },
        runLogs: {
          "456": "npm run agent-check\nAssertionError: expected 1 to be 2",
          "999": "npm run agent-check\nthis successful status should not be read"
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/7", dir);
    const legacy = status.checkDetails.find((check) => check.name === "legacy/status");
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);

    expect(status.checkSummary).toEqual({ total: 2, successful: 1, pending: 0, failing: 1 });
    expect(legacy?.state).toBe("SUCCESS");
    expect(legacy?.url).toBe("https://github.com/o/r/actions/runs/999");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].check.name).toBe("AgentOS CI");
    expect(diagnostics[0].classification).toBe("mechanical_with_sanitized_logs");
  });

  it("classifies successful checks without reading logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/12",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://github.com/o/r/actions/runs/111"
            }
          ]
        },
        runLogs: {
          "111": "this should not be read for successful checks"
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/12", dir);
    const diagnostics = await client.getCheckDiagnostics(status, dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      classification: "successful",
      reason: "GitHub reported this check as successful.",
      log: null
    });
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
    expect(diagnostics[0].classification).toBe("external_or_unknown_report_only");
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
    expect(diagnostics[0].classification).toBe("external_or_unknown_report_only");
    expect(diagnostics[0].log).toBeNull();
    expect(diagnostics[0].reason).toContain("head SHA");
  });

  it("refuses to read Actions logs when the PR head SHA is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/8",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/321"
            }
          ]
        },
        runLogs: {
          "321": "npm run agent-check\nsrc/github.ts(1,1): error TS2304: Cannot find name 'leaked'."
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/8", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);

    expect(status.headSha).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].classification).toBe("external_or_unknown_report_only");
    expect(diagnostics[0].log).toBeNull();
    expect(diagnostics[0].reason).toContain("pull request head SHA");
  });

  it("classifies logless same-repository Actions failures as human-required", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/13",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/112"
            }
          ]
        },
        runLogs: {
          "112": ""
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/13", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      classification: "ambiguous_or_logless_human_required",
      reason: "The failed check did not expose logs.",
      log: null
    });
  });

  it("classifies supported transient infrastructure failures as flaky retryable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/14",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/113"
            }
          ]
        },
        runLogs: {
          "113": "npm ERR! network request failed with ECONNRESET while downloading package metadata"
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/14", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      classification: "flaky_retryable",
      actionsRunId: "113",
      reason: "Failed check logs match a supported transient infrastructure or network condition."
    });
  });

  it("keeps protected branch and merge queue failures out of the flaky retry path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/15",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "required-check",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/114"
            }
          ]
        },
        runLogs: {
          "114": "Merge queue cannot proceed because a required status check is missing on a protected branch."
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/15", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      classification: "external_or_unknown_report_only",
      log: expect.stringContaining("Merge queue")
    });
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

    expect(diagnostics[0].classification).toBe("mechanical_with_sanitized_logs");
    expect(diagnostics[0].log?.length).toBeLessThanOrEqual(4000);
    expect(summary).toContain("sanitized, bounded, untrusted diagnostic data");
    expect(summary).toContain("[REDACTED]");
    expect(summary).not.toContain(secret);
    expect(summary.length).toBeLessThan(1500);
  });

  it("redacts and bounds failed Actions log read errors before diagnostics escape GitHub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    const secret = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/9",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/654"
            }
          ]
        },
        runLogError: `Authorization: Bearer ${secret}\ncommand_failed: GH_TOKEN=${secret} gh run view 654 --log-failed`
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/9", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);
    const summary = summarizeCheckDiagnostics(diagnostics);

    expect(diagnostics[0].classification).toBe("ambiguous_or_logless_human_required");
    expect(diagnostics[0].reason).toContain("[REDACTED]");
    expect(diagnostics[0].reason).not.toContain(secret);
    expect(diagnostics[0].reason).not.toContain("command_failed");
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain("command_failed");
    expect(summary.length).toBeLessThan(1000);
  });

  it("redacts and bounds failed Actions run verification errors before diagnostics escape GitHub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-"));
    const statePath = join(dir, "state.json");
    const secret = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/10",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "AgentOS CI",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/o/r/actions/runs/655"
            }
          ]
        },
        runViewError: `Authorization: Bearer ${secret}\ncommand_failed: GH_TOKEN=${secret} gh run view 655 --json headSha`
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/10", dir);
    const diagnostics = await client.getFailingCheckDiagnostics(status, dir);
    const summary = summarizeCheckDiagnostics(diagnostics);

    expect(diagnostics[0].classification).toBe("external_or_unknown_report_only");
    expect(diagnostics[0].reason).toContain("[REDACTED]");
    expect(diagnostics[0].reason).not.toContain(secret);
    expect(diagnostics[0].reason).not.toContain("command_failed");
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain("command_failed");
    expect(summary.length).toBeLessThan(1000);
  });

  it("cleans local and remote same-repository AgentOS branches after merge", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-cleanup-same-repo-"));
    const pushRemote = await mkdtemp(join(tmpdir(), "agent-os-gh-cleanup-same-repo-origin-"));
    const statePath = join(dir, "state.json");
    await run("git", ["init", "--bare"], pushRemote);
    await run("git", ["init"], dir);
    await run("git", ["remote", "add", "origin", "https://github.com/o/r.git"], dir);
    await run("git", ["remote", "set-url", "--push", "origin", pushRemote], dir);
    await writeFile(join(dir, "README.md"), "test\n", "utf8");
    await run("git", ["add", "README.md"], dir);
    await run("git", ["-c", "user.name=AgentOS", "-c", "user.email=agentos@example.com", "commit", "-m", "init"], dir);
    await run("git", ["branch", "agent/AG-1"], dir);
    await run("git", ["push", "origin", "agent/AG-1"], dir);
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/12",
          state: "MERGED",
          isDraft: false,
          mergeable: null,
          baseRefName: "main",
          headRefName: "agent/AG-1",
          headRepository: { name: "r", owner: { login: "o" } },
          headRepositoryOwner: { login: "o" },
          isCrossRepository: false,
          headRefOid: "abc123",
          mergedAt: "2026-05-05T08:00:00Z",
          statusCheckRollup: []
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/12", dir);
    const cleanup = await client.cleanupMergedPullRequest(
      status,
      { command: "gh", mergeMode: "shepherd", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false, baseBranch: "main" },
      dir
    );

    expect(cleanup.warnings).toEqual([]);
    await expect(run("git", ["show-ref", "--verify", "refs/heads/agent/AG-1"], dir)).rejects.toThrow();
    await expect(run("git", ["--git-dir", pushRemote, "show-ref", "--verify", "refs/heads/agent/AG-1"], dir)).rejects.toThrow();
  });

  it("skips branch cleanup when the PR head repository is a fork with the same branch name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-cleanup-fork-"));
    const statePath = join(dir, "state.json");
    await run("git", ["init"], dir);
    await run("git", ["remote", "add", "origin", "https://github.com/o/r.git"], dir);
    await writeFile(join(dir, "README.md"), "test\n", "utf8");
    await run("git", ["add", "README.md"], dir);
    await run("git", ["-c", "user.name=AgentOS", "-c", "user.email=agentos@example.com", "commit", "-m", "init"], dir);
    await run("git", ["branch", "agent/AG-1"], dir);
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/11",
          state: "MERGED",
          isDraft: false,
          mergeable: null,
          baseRefName: "main",
          headRefName: "agent/AG-1",
          headRepository: { name: "fork", owner: { login: "other" } },
          headRepositoryOwner: { login: "other" },
          isCrossRepository: true,
          headRefOid: "abc123",
          mergedAt: "2026-05-05T08:00:00Z",
          statusCheckRollup: []
        }
      }),
      "utf8"
    );

    const client = new GitHubClient(`GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`);
    const status = await client.getPullRequest("https://github.com/o/r/pull/11", dir);
    const cleanup = await client.cleanupMergedPullRequest(
      status,
      { command: "gh", mergeMode: "shepherd", mergeMethod: "squash", requireChecks: true, deleteBranch: true, doneState: "Done", allowHumanMergeOverride: false, baseBranch: "main" },
      dir
    );

    expect(cleanup.warnings.join("\n")).toContain("does not match current repository o/r");
    await run("git", ["show-ref", "--verify", "refs/heads/agent/AG-1"], dir);
  });
});

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} failed`));
    });
  });
}
