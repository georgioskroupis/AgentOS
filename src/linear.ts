import type { Issue, IssueTracker, ServiceConfig } from "./types.js";

type FetchLike = typeof fetch;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearState {
  id: string;
  name: string;
  type?: string;
}

export class LinearClient implements IssueTracker {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: ServiceConfig["tracker"], fetchImpl: FetchLike = fetch) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.projectSlug = config.projectSlug;
    this.fetchImpl = fetchImpl;
  }

  async fetchCandidates(activeStates: string[]): Promise<Issue[]> {
    const query = `
      query AgentOSIssues($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first) {
          nodes {
            id
            identifier
            title
            description
            priority
            branchName
            url
            createdAt
            updatedAt
            state { name }
            labels { nodes { name } }
            relations { nodes { type relatedIssue { id identifier createdAt updatedAt state { name } } } }
          }
        }
      }
    `;
    const filter = {
      project: { slugId: { eq: this.projectSlug } },
      state: { name: { in: activeStates } }
    };
    const data = await this.request<{ issues: { nodes: unknown[] } }>(query, { filter, first: 100 });
    return data.issues.nodes.map(normalizeLinearIssue).sort(compareIssuesForDispatch);
  }

  async fetchIssueStates(issueIds: string[]): Promise<Map<string, Issue | null>> {
    const result = new Map<string, Issue | null>();
    if (issueIds.length === 0) return result;
    const query = `
      query AgentOSIssuesById($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first) {
          nodes {
            id
            identifier
            title
            description
            priority
            branchName
            url
            createdAt
            updatedAt
            state { name }
            labels { nodes { name } }
            relations { nodes { type relatedIssue { id identifier createdAt updatedAt state { name } } } }
          }
        }
      }
    `;
    const data = await this.request<{ issues: { nodes: unknown[] } }>(query, {
      filter: { id: { in: issueIds } },
      first: issueIds.length
    });
    for (const id of issueIds) result.set(id, null);
    for (const node of data.issues.nodes) {
      const issue = normalizeLinearIssue(node);
      result.set(issue.id, issue);
    }
    return result;
  }

  async fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]> {
    const query = `
      query AgentOSTerminalIssues($filter: IssueFilter, $first: Int!) {
        issues(filter: $filter, first: $first) {
          nodes {
            id
            identifier
            title
            description
            priority
            branchName
            url
            createdAt
            updatedAt
            state { name }
            labels { nodes { name } }
            relations { nodes { type relatedIssue { id identifier createdAt updatedAt state { name } } } }
          }
        }
      }
    `;
    const data = await this.request<{ issues: { nodes: unknown[] } }>(query, {
      filter: {
        project: { slugId: { eq: this.projectSlug } },
        state: { name: { in: terminalStates } }
      },
      first: 100
    });
    return data.issues.nodes.map(normalizeLinearIssue);
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.request<{ teams: { nodes: LinearTeam[] } }>(
      `query AgentOSTeams { teams { nodes { id key name } } }`,
      {}
    );
    return data.teams.nodes;
  }

  async listWorkflowStates(teamId: string): Promise<LinearState[]> {
    const data = await this.request<{ workflowStates: { nodes: LinearState[] } }>(
      `query AgentOSStates($teamId: String!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name type }
        }
      }`,
      { teamId }
    );
    return data.workflowStates.nodes;
  }

  async createProject(name: string, teamId: string): Promise<{ id: string; name: string; slugId?: string }> {
    const data = await this.request<{ projectCreate: { success: boolean; project: { id: string; name: string; slugId?: string } } }>(
      `mutation AgentOSProjectCreate($input: ProjectCreateInput!) {
        projectCreate(input: $input) { success project { id name slugId } }
      }`,
      { input: { name, teamIds: [teamId] } }
    );
    return data.projectCreate.project;
  }

  async createIssue(input: {
    teamId: string;
    title: string;
    description: string;
    projectId?: string;
    stateId?: string;
  }): Promise<{ id: string; identifier: string; title: string }> {
    const data = await this.request<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; title: string } } }>(
      `mutation AgentOSIssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier title } }
      }`,
      {
        input: {
          teamId: input.teamId,
          title: input.title,
          description: input.description,
          projectId: input.projectId,
          stateId: input.stateId
        }
      }
    );
    return data.issueCreate.issue;
  }

  async comment(issueId: string, body: string): Promise<void> {
    await this.request(
      `mutation AgentOSComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: { issueId, body } }
    );
  }

  async move(issueIdentifierOrId: string, stateName: string): Promise<void> {
    const issue = await this.findIssue(issueIdentifierOrId);
    const states = await this.listWorkflowStates(issue.team.id);
    const state = states.find((candidate) => candidate.name.toLowerCase() === stateName.toLowerCase());
    if (!state) {
      throw new Error(`Linear state not found for team ${issue.team.key}: ${stateName}`);
    }
    await this.request(
      `mutation AgentOSIssueMove($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success }
      }`,
      { id: issue.id, input: { stateId: state.id } }
    );
  }

  private async findIssue(issueIdentifierOrId: string): Promise<{ id: string; identifier: string; team: LinearTeam }> {
    const filter = issueIdentifierOrId.includes("-")
      ? { identifier: { eq: issueIdentifierOrId } }
      : { id: { eq: issueIdentifierOrId } };
    const data = await this.request<{ issues: { nodes: Array<{ id: string; identifier: string; team: LinearTeam }> } }>(
      `query AgentOSFindIssue($filter: IssueFilter) {
        issues(filter: $filter, first: 1) { nodes { id identifier team { id key name } } }
      }`,
      { filter }
    );
    const issue = data.issues.nodes[0];
    if (!issue) throw new Error(`Linear issue not found: ${issueIdentifierOrId}`);
    return issue;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new Error("LINEAR_API_KEY is required");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey
      },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) {
      throw new Error(`linear_api_status: ${response.status}`);
    }
    const payload = (await response.json()) as GraphQLResponse<T>;
    if (payload.errors?.length) {
      throw new Error(`linear_graphql_errors: ${payload.errors.map((error) => error.message).join("; ")}`);
    }
    if (!payload.data) {
      throw new Error("linear_unknown_payload");
    }
    return payload.data;
  }
}

export function compareIssuesForDispatch(a: Issue, b: Issue): number {
  const ap = a.priority ?? Number.POSITIVE_INFINITY;
  const bp = b.priority ?? Number.POSITIVE_INFINITY;
  if (ap !== bp) return ap - bp;
  const ac = a.created_at ?? "";
  const bc = b.created_at ?? "";
  if (ac !== bc) return ac.localeCompare(bc);
  return a.identifier.localeCompare(b.identifier);
}

function normalizeLinearIssue(node: unknown): Issue {
  const raw = node as Record<string, any>;
  const labels = Array.isArray(raw.labels?.nodes)
    ? raw.labels.nodes.map((label: { name: string }) => label.name.toLowerCase())
    : [];
  const blockedBy = Array.isArray(raw.relations?.nodes)
    ? raw.relations.nodes
        .filter((relation: any) => String(relation.type ?? "").toLowerCase().includes("block"))
        .map((relation: any) => relation.relatedIssue)
        .filter(Boolean)
        .map((related: any) => ({
          id: related.id ?? null,
          identifier: related.identifier ?? null,
          state: related.state?.name ?? null,
          created_at: related.createdAt ?? null,
          updated_at: related.updatedAt ?? null
        }))
    : [];
  return {
    id: String(raw.id),
    identifier: String(raw.identifier),
    title: String(raw.title),
    description: typeof raw.description === "string" ? raw.description : null,
    priority: typeof raw.priority === "number" ? raw.priority : null,
    state: String(raw.state?.name ?? raw.state ?? ""),
    branch_name: typeof raw.branchName === "string" ? raw.branchName : null,
    url: typeof raw.url === "string" ? raw.url : null,
    labels,
    blocked_by: blockedBy,
    created_at: raw.createdAt ?? null,
    updated_at: raw.updatedAt ?? null
  };
}

