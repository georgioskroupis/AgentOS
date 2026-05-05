import { describe, expect, it } from "vitest";
import { isLinearIdentifier, LinearClient } from "../src/linear.js";
import type { ServiceConfig } from "../src/types.js";

const trackerConfig: ServiceConfig["tracker"] = {
  kind: "linear",
  endpoint: "https://linear.test/graphql",
  apiKey: "lin_test",
  projectSlug: "AgentOS",
  activeStates: ["Ready"],
  terminalStates: ["Done"],
  runningState: "In Progress",
  reviewState: "Human Review",
  mergeState: null,
  needsInputState: "Human Review"
};

describe("LinearClient", () => {
  it("paginates candidates and only treats blocked_by relations as blockers", async () => {
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      {
        data: {
          issues: {
            nodes: [
              issueNode("issue-1", "VER-1", 2, [
                relation("blocks", issueNode("issue-downstream", "VER-3", 3)),
                relation("blocked_by", issueNode("issue-blocker", "VER-0", 1, [], "Todo"))
              ])
            ],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" }
          }
        }
      },
      {
        data: {
          issues: {
            nodes: [issueNode("issue-2", "VER-2", 1)],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    const issues = await client.fetchCandidates(["Ready"]);

    expect(requests.map((request) => request.variables.after)).toEqual([null, "cursor-1"]);
    expect(issues.map((issue) => issue.identifier)).toEqual(["VER-2", "VER-1"]);
    expect(issues.find((issue) => issue.identifier === "VER-1")?.blocked_by).toEqual([
      expect.objectContaining({ identifier: "VER-0" })
    ]);
  });

  it("comments on issues by Linear identifier", async () => {
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      { data: { issues: { nodes: [{ id: "issue-5", identifier: "VER-5", team: { id: "team-1", key: "VER", name: "Verity" } }] } } },
      { data: { commentCreate: { success: true } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    await client.comment("ver-5", "handoff");

    expect(requests[0].variables.filter).toEqual({
      team: { key: { eq: "VER" } },
      number: { eq: 5 },
      project: agentOsProjectFilter()
    });
    expect(requests[1].variables.input).toEqual({ issueId: "issue-5", body: "handoff" });
  });

  it("updates existing AgentOS lifecycle comments by marker", async () => {
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      { data: { issues: { nodes: [{ id: "issue-5", identifier: "VER-5", team: { id: "team-1", key: "VER", name: "Verity" } }] } } },
      { data: { issue: { comments: { nodes: [{ id: "comment-1", body: "<!-- agentos:event=run_started:VER-5 -->\nold" }] } } } },
      { data: { commentUpdate: { success: true } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    await client.upsertComment("VER-5", "new", "run_started:VER-5");

    expect(requests[2].variables).toEqual({
      id: "comment-1",
      input: { body: "<!-- agentos:event=run_started:VER-5 -->\nnew" }
    });
  });

  it("updates duplicate custom lifecycle markers by configured behavior", async () => {
    const marker = "<!-- agentos:event=status_update issue=VER-5 -->";
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      {
        data: {
          issues: {
            nodes: [
              {
                id: "issue-5",
                identifier: "VER-5",
                state: { name: "In Progress" },
                team: { id: "team-1", key: "VER", name: "Verity" }
              }
            ]
          }
        }
      },
      { data: { issue: { comments: { nodes: [{ id: "comment-1", body: `${marker}\nold` }] } } } },
      { data: { commentUpdate: { success: true } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    const result = await client.upsertCommentWithMarker("VER-5", "new", marker, "upsert");

    expect(result).toBe("updated");
    expect(requests[2].variables).toEqual({
      id: "comment-1",
      input: { body: `${marker}\nnew` }
    });
  });

  it("finds duplicate lifecycle markers beyond the first comments page", async () => {
    const marker = "<!-- agentos:event=status_update issue=VER-5 -->";
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      {
        data: {
          issues: {
            nodes: [
              {
                id: "issue-5",
                identifier: "VER-5",
                state: { name: "In Progress" },
                team: { id: "team-1", key: "VER", name: "Verity" }
              }
            ]
          }
        }
      },
      {
        data: {
          issue: {
            comments: {
              nodes: [{ id: "comment-old", body: "unmarked lifecycle noise" }],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" }
            }
          }
        }
      },
      {
        data: {
          issue: {
            comments: {
              nodes: [{ id: "comment-marked", body: `${marker}\nold` }],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      },
      { data: { commentUpdate: { success: true } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    const result = await client.upsertCommentWithMarker("VER-5", "new", marker, "upsert");

    expect(result).toBe("updated");
    expect(requests[1].variables).toEqual({ id: "issue-5", after: null });
    expect(requests[2].variables).toEqual({ id: "issue-5", after: "cursor-1" });
    expect(requests[3].variables).toEqual({
      id: "comment-marked",
      input: { body: `${marker}\nnew` }
    });
  });

  it("skips duplicate custom lifecycle markers when configured", async () => {
    const marker = "<!-- agentos:event=status_update issue=VER-5 -->";
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      {
        data: {
          issues: {
            nodes: [
              {
                id: "issue-5",
                identifier: "VER-5",
                state: { name: "In Progress" },
                team: { id: "team-1", key: "VER", name: "Verity" }
              }
            ]
          }
        }
      },
      { data: { issue: { comments: { nodes: [{ id: "comment-1", body: `${marker}\nold` }] } } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    const result = await client.upsertCommentWithMarker("VER-5", "new", marker, "skip");

    expect(result).toBe("skipped");
    expect(requests).toHaveLength(2);
  });

  it("creates AgentOS lifecycle comments when no marker exists", async () => {
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      { data: { issues: { nodes: [{ id: "issue-5", identifier: "VER-5", team: { id: "team-1", key: "VER", name: "Verity" } }] } } },
      { data: { issue: { comments: { nodes: [] } } } },
      { data: { commentCreate: { success: true } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    await client.upsertComment("VER-5", "new", "run_started:VER-5");

    expect(requests[2].variables.input).toEqual({
      issueId: "issue-5",
      body: "<!-- agentos:event=run_started:VER-5 -->\nnew"
    });
  });

  it("moves issues by UUID without confusing them for Linear identifiers", async () => {
    const issueId = "01974a5a-40bb-7bf1-b09f-b6d1f18d1234";
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      { data: { issues: { nodes: [{ id: issueId, identifier: "VER-5", team: { id: "team-1", key: "VER", name: "Verity" } }] } } },
      { data: { workflowStates: { nodes: [{ id: "state-review", name: "Human Review", type: "started" }] } } },
      { data: { issueUpdate: { success: true } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    await client.move(issueId, "Human Review");

    expect(requests[0].variables.filter).toEqual({ id: { eq: issueId }, project: agentOsProjectFilter() });
    expect(requests[2].variables).toEqual({ id: issueId, input: { stateId: "state-review" } });
  });

  it("creates missing workflow states for setup", async () => {
    const requests: Array<Record<string, any>> = [];
    const fetchImpl = fakeFetch(requests, [
      { data: { workflowStates: { nodes: [{ id: "state-todo", name: "Todo", type: "unstarted" }] } } },
      { data: { workflowStateCreate: { success: true, workflowState: { id: "state-review", name: "Human Review", type: "started" } } } }
    ]);

    const client = new LinearClient(trackerConfig, fetchImpl);
    const result = await client.ensureWorkflowStates("team-1", [
      { name: "Todo", type: "unstarted" },
      { name: "Human Review", type: "started" }
    ]);

    expect(result.created).toEqual([{ id: "state-review", name: "Human Review", type: "started" }]);
    expect(requests[1].variables.input).toEqual({ teamId: "team-1", name: "Human Review", type: "started" });
  });

  it("recognizes Linear issue identifiers", () => {
    expect(isLinearIdentifier("VER-21")).toBe(true);
    expect(isLinearIdentifier("01974a5a-40bb-7bf1-b09f-b6d1f18d1234")).toBe(false);
  });
});

function fakeFetch(requests: Array<Record<string, any>>, responses: unknown[]): typeof fetch {
  return (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch call");
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;
}

function agentOsProjectFilter(): Record<string, unknown> {
  return {
    or: [{ slugId: { eq: "AgentOS" } }, { name: { eq: "AgentOS" } }]
  };
}

function issueNode(
  id: string,
  identifier: string,
  priority: number,
  relations: unknown[] = [],
  state = "Ready"
): Record<string, unknown> {
  return {
    id,
    identifier,
    title: `${identifier} title`,
    description: null,
    priority,
    branchName: null,
    url: `https://linear.test/${identifier}`,
    createdAt: `2026-01-0${priority}T00:00:00.000Z`,
    updatedAt: `2026-01-0${priority}T00:00:00.000Z`,
    state: { name: state },
    labels: { nodes: [] },
    relations: { nodes: relations }
  };
}

function relation(type: string, relatedIssue: Record<string, unknown>): Record<string, unknown> {
  return { type, relatedIssue };
}
