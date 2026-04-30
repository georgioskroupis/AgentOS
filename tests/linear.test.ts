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

    expect(requests[0].variables.filter).toEqual({ team: { key: { eq: "VER" } }, number: { eq: 5 } });
    expect(requests[1].variables.input).toEqual({ issueId: "issue-5", body: "handoff" });
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

    expect(requests[0].variables.filter).toEqual({ id: { eq: issueId } });
    expect(requests[2].variables).toEqual({ id: issueId, input: { stateId: "state-review" } });
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
