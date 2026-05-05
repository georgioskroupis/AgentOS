import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractOutcome,
  extractPullRequestUrls,
  issueStateFromHandoff,
  IssueStateStore,
  mergeTargetAmbiguityReason,
  mergeTargetPullRequest,
  primaryPullRequestUrl,
  pullRequestUrls,
  reviewTargetPullRequests
} from "../src/issue-state.js";
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
      prs: [{ url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary" }],
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
    expect(state?.prs?.map((pr) => pr.role)).toEqual(["primary", "follow-up"]);
    expect(state?.prUrl).toBe("https://github.com/o/r/pull/1");
    expect(pullRequestUrls(state)).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
  });

  it("parses explicit PR roles and selects review and merge targets", () => {
    const state = issueStateFromHandoff(
      issue,
      [
        "AgentOS-Outcome: implemented",
        "Primary PR: https://github.com/o/r/pull/1",
        "Supporting PR: https://github.com/o/r/pull/2",
        "Docs PR: https://github.com/o/r/pull/3",
        "Do not merge PR: https://github.com/o/r/pull/4"
      ].join("\n")
    );

    expect(state?.prs?.map((pr) => [pr.url, pr.role])).toEqual([
      ["https://github.com/o/r/pull/1", "primary"],
      ["https://github.com/o/r/pull/2", "supporting"],
      ["https://github.com/o/r/pull/3", "docs"],
      ["https://github.com/o/r/pull/4", "do-not-merge"]
    ]);
    expect(reviewTargetPullRequests(state).map((pr) => pr.url)).toEqual(["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/3"]);
    expect(reviewTargetPullRequests(state, "primary").map((pr) => pr.url)).toEqual(["https://github.com/o/r/pull/1"]);
    expect(mergeTargetPullRequest(state)?.url).toBe("https://github.com/o/r/pull/1");
  });

  it("does not select review-only PR roles for merge", () => {
    const state = issueStateFromHandoff(
      issue,
      [
        "AgentOS-Outcome: implemented",
        "Supporting PR: https://github.com/o/r/pull/2",
        "Follow-up PR: https://github.com/o/r/pull/3",
        "Do-not-merge PR: https://github.com/o/r/pull/4"
      ].join("\n")
    );

    expect(reviewTargetPullRequests(state)).toEqual([]);
    expect(mergeTargetPullRequest(state)).toBeNull();
  });

  it("requires exactly one primary PR for primary review target mode", () => {
    const supportingOnly = issueStateFromHandoff(
      issue,
      ["AgentOS-Outcome: implemented", "Supporting PR: https://github.com/o/r/pull/2"].join("\n")
    );
    const multiplePrimary = issueStateFromHandoff(
      issue,
      [
        "AgentOS-Outcome: implemented",
        "Primary PR: https://github.com/o/r/pull/1",
        "Primary PR: https://github.com/o/r/pull/2"
      ].join("\n")
    );

    expect(reviewTargetPullRequests(supportingOnly, "primary")).toEqual([]);
    expect(reviewTargetPullRequests(multiplePrimary, "primary")).toEqual([]);
  });

  it("treats multiple primary PRs as an ambiguous merge target", () => {
    const state = issueStateFromHandoff(
      issue,
      [
        "AgentOS-Outcome: implemented",
        "Primary PR: https://github.com/o/r/pull/1",
        "Primary PR: https://github.com/o/r/pull/2"
      ].join("\n")
    );

    expect(mergeTargetPullRequest(state)).toBeNull();
    expect(mergeTargetAmbiguityReason(state)).toContain("Multiple primary pull requests");
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

  it("lets the latest handoff role override a persisted default role for the same PR URL", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-issue-state-relabel-"));
    const store = new IssueStateStore(repo);
    const first = issueStateFromHandoff(issue, "AgentOS-Outcome: implemented\n\nPR: https://github.com/o/r/pull/1");
    const second = issueStateFromHandoff(issue, "AgentOS-Outcome: implemented\n\nDo not merge PR: https://github.com/o/r/pull/1");
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    await store.merge("AG-1", first!);
    await store.merge("AG-1", second!);

    const persisted = JSON.parse(await readFile(join(repo, ".agent-os", "state", "issues", "AG-1.json"), "utf8"));
    expect(persisted.prs).toMatchObject([{ url: "https://github.com/o/r/pull/1", role: "do-not-merge" }]);
    expect(reviewTargetPullRequests(persisted)).toEqual([]);
    expect(mergeTargetPullRequest(persisted)).toBeNull();
  });
});
