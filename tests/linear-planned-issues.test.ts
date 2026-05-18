import { describe, expect, it } from "vitest";
import {
  formatLinearPlanError,
  parseLinearPlannedIssueInput,
  plannedIssueMarker,
  upsertLinearPlannedIssues,
  type LinearPlannedIssueAdapter,
  type LinearPlannedIssueReference,
  type LinearPlannedIssueWriteInput
} from "../src/linear-planned-issues.js";
import { estimateScope, estimateTouchedSubsystems } from "../src/scope-report-scoring.js";
import { selectScopeText } from "../src/scope-report-scope-text.js";
import type { Issue } from "../src/types.js";
import type { ScopeEvidence } from "../src/scope-report.js";

describe("Linear planned issue helper", () => {
  it("creates child and follow-up issues from plan input with inherited assignees and guardrail-friendly descriptions", async () => {
    const adapter = new FakePlannedIssueAdapter();
    const plan = parseLinearPlannedIssueInput(`
parent_issue: VER-53
state: Todo
child_issues:
  - marker: ver-53-child-api
    title: Export settings slice
    goal: Add settings export API behavior.
    scope: Return the selected settings payload from one endpoint.
    acceptance_criteria:
      - Focused API test covers the response.
      - Typecheck passes.
    context:
      - Parent planning includes broader dashboard work.
    out_of_scope:
      - Dashboard UI changes.
follow_up_issues:
  - marker: ver-53-follow-docs
    title: Refresh settings docs
    scope: Update one runbook section.
    acceptance_criteria:
      - Runbook mentions the new export endpoint.
`);

    const result = await upsertLinearPlannedIssues(adapter, plan, {
      apiKey: "lin_test_key",
      projectSlug: "AgentOS"
    });

    expect(result.issues.map((issue) => issue.action)).toEqual(["created", "created"]);
    expect(adapter.created).toHaveLength(2);
    expect(adapter.created[0]).toMatchObject({
      teamId: "team-1",
      projectId: "project-1",
      stateId: "state-todo",
      parentId: "parent-1",
      assigneeId: "user-supervisor"
    });
    expect(adapter.created[1]).toMatchObject({
      teamId: "team-1",
      projectId: "project-1",
      stateId: "state-todo",
      assigneeId: "user-supervisor"
    });
    expect(adapter.created[1].parentId).toBeUndefined();
    expect(adapter.created[0].description).toContain(plannedIssueMarker("ver-53-child-api"));
    expect(adapter.created[0].description).toContain("Active scope:");
    expect(adapter.created[0].description).toContain("Context:");
    expect(adapter.created[0].description).toContain("Assignee inherited from parent issue (user-supervisor).");

    const issue = fakeIssue({ title: adapter.created[0].title, description: adapter.created[0].description });
    const scopeText = selectScopeText(issue, null, null);
    const evidence = minimalScopeEvidence(scopeText.scoredAcceptanceBulletCount);
    const touched = estimateTouchedSubsystems(issue, null, evidence, scopeText);
    const scope = estimateScope(issue, "missing", touched, evidence, scopeText);

    expect(scopeText.source).toBe("issue_active_sections");
    expect(scopeText.text).not.toContain("Parent planning includes broader dashboard work.");
    expect(scopeText.ignoredSections).toContain("Context");
    expect(scope.scopeSize).toBe("small");
  });

  it("reuses generated issues by idempotency marker", async () => {
    const adapter = new FakePlannedIssueAdapter();
    adapter.existingByMarker.set(plannedIssueMarker("reuse-me"), fakeReference({ id: "existing-1", identifier: "VER-88", title: "Old title" }));
    const plan = parseLinearPlannedIssueInput(`
parent_issue: VER-53
child_issues:
  - marker: reuse-me
    title: Reused child
    scope: Update the existing generated issue.
    acceptance_criteria:
      - Existing issue is updated.
`);

    const result = await upsertLinearPlannedIssues(adapter, plan, {
      apiKey: "lin_test_key",
      projectSlug: "AgentOS"
    });

    expect(result.issues[0]).toMatchObject({ action: "updated", identifier: "VER-88" });
    expect(adapter.created).toHaveLength(0);
    expect(adapter.updated).toHaveLength(1);
    expect(adapter.updated[0].issueId).toBe("existing-1");
  });

  it("writes blocks relations for blocked_by and unblocks plan references", async () => {
    const adapter = new FakePlannedIssueAdapter();
    adapter.references.set("VER-99", fakeReference({ id: "external-99", identifier: "VER-99" }));
    const plan = parseLinearPlannedIssueInput(`
parent_issue: VER-53
child_issues:
  - marker: slice-a
    title: Slice A
    scope: Add the first small change.
    acceptance_criteria:
      - First focused check passes.
    unblocks:
      - VER-99
  - marker: slice-b
    title: Slice B
    scope: Add the second small change.
    acceptance_criteria:
      - Second focused check passes.
    blocked_by:
      - slice-a
`);

    await upsertLinearPlannedIssues(adapter, plan, {
      apiKey: "lin_test_key",
      projectSlug: "AgentOS"
    });

    expect(adapter.relations).toEqual(
      expect.arrayContaining([
        { issueId: "issue-1", relatedIssueId: "external-99", type: "blocks" },
        { issueId: "issue-1", relatedIssueId: "issue-2", type: "blocks" }
      ])
    );
  });

  it("fails clearly and redacts diagnostics when credentials are missing", async () => {
    const adapter = new FakePlannedIssueAdapter();
    const plan = parseLinearPlannedIssueInput(`
parent_issue: VER-53
child_issues:
  - marker: missing-creds
    title: Missing credentials
    scope: Exercise failure handling.
    acceptance_criteria:
      - Failure is clear.
`);

    await expect(upsertLinearPlannedIssues(adapter, plan, { projectSlug: "AgentOS" })).rejects.toThrow(
      "linear_plan_missing_credentials"
    );
    const redacted = formatLinearPlanError(new Error("linear_graphql_errors: token lin_abcdefghijklmnopqrstuvwxyz123456 failed"));
    expect(redacted.message).toContain("[REDACTED]");
    expect(redacted.message).not.toContain("lin_abcdefghijklmnopqrstuvwxyz123456");
  });
});

class FakePlannedIssueAdapter implements LinearPlannedIssueAdapter {
  readonly created: LinearPlannedIssueWriteInput[] = [];
  readonly updated: Array<{ issueId: string; input: LinearPlannedIssueWriteInput }> = [];
  readonly relations: Array<{ issueId: string; relatedIssueId: string; type: "blocks" | "related" }> = [];
  readonly existingByMarker = new Map<string, LinearPlannedIssueReference>();
  readonly references = new Map<string, LinearPlannedIssueReference>([
    ["VER-53", fakeReference({ id: "parent-1", identifier: "VER-53", title: "Parent issue", assigneeId: "user-supervisor" })],
    ["parent-1", fakeReference({ id: "parent-1", identifier: "VER-53", title: "Parent issue", assigneeId: "user-supervisor" })]
  ]);

  async listTeams() {
    return [{ id: "team-1", key: "VER", name: "Verity" }];
  }

  async listWorkflowStates() {
    return [{ id: "state-todo", name: "Todo" }];
  }

  async findProject(slugOrName: string) {
    return slugOrName === "AgentOS" ? { id: "project-1", name: "AgentOS", slugId: "AgentOS" } : null;
  }

  async findIssueReference(issueIdentifierOrId: string) {
    const issue = this.references.get(issueIdentifierOrId);
    if (!issue) throw new Error(`missing fake issue: ${issueIdentifierOrId}`);
    return issue;
  }

  async findIssueByPlanningMarker(markerText: string) {
    return this.existingByMarker.get(markerText) ?? null;
  }

  async createIssue(input: LinearPlannedIssueWriteInput) {
    this.created.push(input);
    const issue = fakeReference({
      id: `issue-${this.created.length}`,
      identifier: `VER-${100 + this.created.length}`,
      title: input.title,
      assigneeId: input.assigneeId ?? null
    });
    this.references.set(issue.id, issue);
    this.references.set(issue.identifier, issue);
    return issue;
  }

  async updateIssue(issueId: string, input: LinearPlannedIssueWriteInput) {
    this.updated.push({ issueId, input });
    const previous = [...this.existingByMarker.values()].find((issue) => issue.id === issueId) ?? this.references.get(issueId);
    const issue = fakeReference({
      id: issueId,
      identifier: previous?.identifier ?? "VER-200",
      title: input.title,
      assigneeId: input.assigneeId ?? previous?.assigneeId ?? null
    });
    this.references.set(issue.id, issue);
    this.references.set(issue.identifier, issue);
    return issue;
  }

  async createIssueRelation(input: { issueId: string; relatedIssueId: string; type: "blocks" | "related" }) {
    this.relations.push(input);
  }
}

function fakeReference(overrides: Partial<LinearPlannedIssueReference> = {}): LinearPlannedIssueReference {
  return {
    id: "issue-1",
    identifier: "VER-1",
    title: "Issue",
    state: "Todo",
    team: { id: "team-1", key: "VER", name: "Verity" },
    url: `https://linear.test/${overrides.identifier ?? "VER-1"}`,
    assigneeId: null,
    assigneeEmail: null,
    project: { id: "project-1", name: "AgentOS", slugId: "AgentOS" },
    ...overrides
  };
}

function fakeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "VER-101",
    title: "Export settings slice",
    description: null,
    priority: null,
    state: "Todo",
    branch_name: null,
    url: null,
    labels: [],
    blocked_by: [],
    created_at: null,
    updated_at: null,
    ...overrides
  };
}

function minimalScopeEvidence(acceptanceCount: number): ScopeEvidence {
  return {
    issueText: {
      hasDescription: true,
      acceptanceBulletCount: acceptanceCount,
      scoredAcceptanceBulletCount: acceptanceCount,
      scoringTextSource: "issue_active_sections",
      ignoredSections: [],
      labelCount: 0
    },
    planningReentry: {
      status: "not_required",
      reason: "test",
      decisionCommentId: null,
      activeScopePresent: false,
      activeScopeBounded: false,
      decompositionEvidencePresent: false
    },
    state: { present: false, outcome: null, phase: null, lastError: null, stopReason: null },
    workspace: {
      present: false,
      path: null,
      branch: null,
      headSha: null,
      dirty: false,
      upstreamMissing: false,
      aheadCount: 0,
      recoverable: false,
      reasons: [],
      nextSafeAction: null
    },
    pullRequests: { present: false, count: 0, urls: [], roles: [] },
    validation: { present: false, status: null, finalStatus: null, latestCommand: null, latestCommandFinishedAt: null },
    handoff: { present: false, repoPath: null, workspacePath: null, runArtifactPath: null },
    linearComments: {
      fetched: false,
      present: false,
      count: 0,
      latestCommentId: null,
      latestCommentAuthor: null,
      latestCommentAt: null,
      recent: []
    },
    humanDecisions: { present: false, count: 0, latest: null },
    runtime: {
      activeRunPresent: false,
      retryPresent: false,
      runId: null,
      phase: null,
      lastEventAt: null,
      retryAttempt: null,
      retryError: null
    },
    lastRun: {
      present: false,
      runId: null,
      status: null,
      stopReason: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      lastEventAt: null,
      latestEventType: null,
      latestEventAt: null,
      eventCount: 0,
      tokenInput: null,
      tokenOutput: null,
      tokenTotal: null,
      latestCommandActivity: null,
      quietValidationStop: false
    }
  };
}
