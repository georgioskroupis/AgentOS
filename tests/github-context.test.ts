import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readGitHubReviewContext } from "../src/github-context.js";

const fixture = resolve("tests/fixtures/fake-gh.mjs");

describe("GitHub review context", () => {
  it("carries full check diagnostics into reviewer context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-os-gh-context-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        view: {
          url: "https://github.com/o/r/pull/1",
          state: "OPEN",
          isDraft: false,
          mergeable: "MERGEABLE",
          headRefOid: "abc123",
          statusCheckRollup: [
            {
              name: "passing-ci",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              detailsUrl: "https://github.com/o/r/actions/runs/111"
            },
            {
              name: "pending-ci",
              status: "IN_PROGRESS",
              conclusion: null,
              detailsUrl: "https://checks.example/pending/1"
            },
            {
              name: "third-party-ci",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://checks.example/failure/1"
            }
          ],
          files: [{ path: "src/github-context.ts" }]
        }
      }),
      "utf8"
    );

    const context = await readGitHubReviewContext(
      [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: "2026-01-02T00:00:00.000Z" }],
      { githubCommand: `GH_FAKE_STATE=${JSON.stringify(statePath)} node ${JSON.stringify(fixture)}`, repoRoot: dir }
    );

    expect(context.entries[0].checkDiagnostics.map((diagnostic) => [diagnostic.check.name, diagnostic.classification])).toEqual([
      ["passing-ci", "successful"],
      ["pending-ci", "external_or_unknown_report_only"],
      ["third-party-ci", "external_or_unknown_report_only"]
    ]);
    expect(context.summary).toContain("passing-ci: successful");
    expect(context.summary).toContain("pending-ci: external-or-unknown-report-only");
    expect(context.summary).toContain("third-party-ci: external-or-unknown-report-only");
    expect(context.summary).toContain("Report only");
  });
});
