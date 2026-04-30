import { describe, expect, it } from "vitest";
import { extractOutcome, issueStateFromHandoff } from "../src/issue-state.js";
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

    expect(state).toMatchObject({
      prUrl: "https://github.com/o/r/pull/1",
      outcome: "implemented",
      reviewStatus: "pending",
      reviewIteration: 0
    });
  });
});
