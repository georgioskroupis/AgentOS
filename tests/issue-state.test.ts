import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractOutcome, extractPullRequestUrls, issueStateFromHandoff, IssueStateStore, primaryPullRequestUrl, pullRequestUrls } from "../src/issue-state.js";
import type { Issue } from "../src/types.js";

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Ready issue",
  description: null,
  priority: 1,
  state: "Human Review",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null
};

describe("issue state handoff parsing", () => {
  it("extracts an already-satisfied no-op outcome without a PR", () => {
    const handoff = [
      "AgentOS-Outcome: already-satisfied",
      "",
      "### Implementation audit",
      "",
      "Acceptance criteria are already covered by the current codebase.",
      "",
      "Validation: npm run agent-check passed."
    ].join("\n");

    expect(extractOutcome(handoff)).toBe("already_satisfied");
    expect(issueStateFromHandoff(issue, handoff)).toMatchObject({
      schemaVersion: 1,
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      outcome: "already_satisfied"
    });
  });

  it("extracts implemented PR metadata and outcome", () => {
    const state = issueStateFromHandoff(
      issue,
      "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1"
    );

    expect(extractPullRequestUrls("PR: https://github.com/o/r/pull/1\nFollow-up: https://github.com/o/r/pull/2")).toEqual([
      "https://github.com/o/r/pull/1",
      "https://github.com/o/r/pull/2"
    ]);
    expect(state).toMatchObject({
      schemaVersion: 1,
      prUrl: "https://github.com/o/r/pull/1",
      prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff" }],
      outcome: "implemented",
      reviewStatus: "pending",
      reviewIteration: 0
    });
  });

  it("treats implemented handoff-only outcomes as valid no-PR issue state", () => {
    const state = issueStateFromHandoff(
      issue,
      [
        "AgentOS-Outcome: implemented",
        "",
        "### Summary",
        "",
        "Investigation completed and follow-up issue AG-2 was filed. No repo change was needed."
      ].join("\n")
    );

    expect(state).toMatchObject({
      schemaVersion: 1,
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      outcome: "implemented"
    });
    expect(state?.prs).toBeUndefined();
    expect(state?.prUrl).toBeUndefined();
    expect(state?.reviewStatus).toBeUndefined();
  });

  it("stores multiple PRs from handoff text", () => {
    const state = issueStateFromHandoff(
      issue,
      [
        "AgentOS-Outcome: implemented",
        "PR: https://github.com/o/r/pull/1",
        "Follow-up PR: https://github.com/o/r/pull/2",
        "Duplicate mention: https://github.com/o/r/pull/1"
      ].join("\n")
    );

    expect(state?.prs?.map((pr) => pr.url)).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
    expect(state?.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(pullRequestUrls(state)).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
  });

  it("uses prs as authoritative while preserving legacy prUrl as a mirror", () => {
    const state = {
      prs: [
        { url: "https://github.com/o/r/pull/2", source: "handoff" as const, discoveredAt: "2026-01-02T00:00:00.000Z" },
        { url: "https://github.com/o/r/pull/3", source: "handoff" as const, discoveredAt: "2026-01-03T00:00:00.000Z" }
      ],
      prUrl: "https://github.com/o/r/pull/1"
    };

    expect(primaryPullRequestUrl(state)).toBe("https://github.com/o/r/pull/2");
    expect(pullRequestUrls(state)).toEqual([
      "https://github.com/o/r/pull/2",
      "https://github.com/o/r/pull/3",
      "https://github.com/o/r/pull/1"
    ]);
  });

  it("lazily migrates legacy prUrl state to prs on merge", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-issue-state-"));
    await mkdir(join(repo, ".agent-os", "state", "issues"), { recursive: true });
    await writeFile(
      join(repo, ".agent-os", "state", "issues", "AG-1.json"),
      JSON.stringify({
        issueId: "issue-1",
        issueIdentifier: "AG-1",
        prUrl: "https://github.com/o/r/pull/1",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }),
      "utf8"
    );

    const store = new IssueStateStore(repo);
    const read = await store.read("AG-1");
    expect(read).toMatchObject({
      schemaVersion: 1,
      prs: [{ url: "https://github.com/o/r/pull/1", source: "legacy" }]
    });

    await store.merge("AG-1", {
      issueId: "issue-1",
      issueIdentifier: "AG-1",
      prs: [{ url: "https://github.com/o/r/pull/2", source: "manual", discoveredAt: "2026-01-02T00:00:00.000Z" }]
    });
    const persisted = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.prs.map((pr: { url: string }) => pr.url)).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
  });
});
