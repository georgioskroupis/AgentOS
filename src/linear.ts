import type { Issue, IssueTracker, LifecycleDuplicateCommentBehavior, ServiceConfig } from "./types.js";

type FetchLike = typeof fetch;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface IssueConnection {
  issues: {
    nodes: unknown[];
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
  };
}

const issueNodeSelection = `
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
`;

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

export interface LinearProject {
  id: string;
  name: string;
  slugId?: string;
}

export interface LinearIssueReference {
  id: string;
  identifier: string;
  state: string;
  team: LinearTeam;
}

export type LinearCommentWriteResult = "created" | "updated" | "skipped";

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
    const filter = {
      project: projectFilter(this.projectSlug),
      state: { name: { in: activeStates } }
    };
    return (await this.fetchIssues(filter)).sort(compareIssuesForDispatch);
  }

  async fetchIssueStates(issueIds: string[]): Promise<Map<string, Issue | null>> {
    const result = new Map<string, Issue | null>();
    if (issueIds.length === 0) return result;
    const data = await this.request<IssueConnection>(issueQuery("AgentOSIssuesById"), {
      filter: { id: { in: issueIds } },
      first: issueIds.length,
      after: null
    });
    for (const id of issueIds) result.set(id, null);
    for (const node of data.issues.nodes) {
      const issue = normalizeLinearIssue(node);
      result.set(issue.id, issue);
    }
    return result;
  }

  async fetchTerminalIssues(terminalStates: string[]): Promise<Issue[]> {
    return this.fetchIssues({
      project: projectFilter(this.projectSlug),
      state: { name: { in: terminalStates } }
    });
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
      `query AgentOSStates($teamId: ID!) {
        workflowStates(filter: { team: { id: { eq: $teamId } } }) {
          nodes { id name type }
        }
      }`,
      { teamId }
    );
    return data.workflowStates.nodes;
  }

  async findProject(slugOrName: string): Promise<LinearProject | null> {
    const data = await this.request<{ projects: { nodes: LinearProject[] } }>(
      `query AgentOSProjects($filter: ProjectFilter) {
        projects(filter: $filter, first: 10) { nodes { id name slugId } }
      }`,
      {
        filter: {
          or: [{ slugId: { eq: slugOrName } }, { name: { eq: slugOrName } }]
        }
      }
    );
    return data.projects.nodes.find((project) => project.slugId === slugOrName || project.name === slugOrName) ?? null;
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

  async createWorkflowState(input: {
    teamId: string;
    name: string;
    type: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  }): Promise<LinearState> {
    const data = await this.request<{ workflowStateCreate: { success: boolean; workflowState: LinearState } }>(
      `mutation AgentOSWorkflowStateCreate($input: WorkflowStateCreateInput!) {
        workflowStateCreate(input: $input) { success workflowState { id name type } }
      }`,
      { input: { teamId: input.teamId, name: input.name, type: input.type } }
    );
    return data.workflowStateCreate.workflowState;
  }

  async ensureWorkflowStates(
    teamId: string,
    required: Array<{ name: string; type: "backlog" | "unstarted" | "started" | "completed" | "canceled" }>
  ): Promise<{ states: LinearState[]; created: LinearState[]; missing: Array<{ name: string; type: string }> }> {
    const states = await this.listWorkflowStates(teamId);
    const created: LinearState[] = [];
    const missing: Array<{ name: string; type: string }> = [];
    for (const item of required) {
      if (states.some((state) => state.name.toLowerCase() === item.name.toLowerCase())) continue;
      try {
        const state = await this.createWorkflowState({ teamId, name: item.name, type: item.type });
        states.push(state);
        created.push(state);
      } catch {
        missing.push(item);
      }
    }
    return { states, created, missing };
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

  async comment(issueIdentifierOrId: string, body: string): Promise<void> {
    const issue = await this.findIssueReference(issueIdentifierOrId);
    await this.request(
      `mutation AgentOSComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }`,
      { input: { issueId: issue.id, body } }
    );
  }

  async upsertComment(issueIdentifierOrId: string, body: string, key: string): Promise<void> {
    const marker = linearCommentMarker(key);
    await this.upsertCommentWithMarker(issueIdentifierOrId, body, marker, "upsert");
  }

  async upsertCommentWithMarker(
    issueIdentifierOrId: string,
    body: string,
    marker: string,
    duplicateBehavior: LifecycleDuplicateCommentBehavior = "upsert"
  ): Promise<LinearCommentWriteResult> {
    const issue = await this.findIssueReference(issueIdentifierOrId);
    const markedBody = body.includes(marker) ? body : `${marker}\n${body}`;
    const comments = await this.listIssueComments(issue.id);
    const existing = comments.find((comment) => comment.body.includes(marker));
    if (existing) {
      if (duplicateBehavior === "skip") return "skipped";
      if (duplicateBehavior === "error") throw new Error(`linear_duplicate_comment_marker: ${marker}`);
      await this.request(
        `mutation AgentOSCommentUpdate($id: String!, $input: CommentUpdateInput!) {
          commentUpdate(id: $id, input: $input) { success }
        }`,
        { id: existing.id, input: { body: markedBody } }
      );
      return "updated";
    } else {
      await this.request(
        `mutation AgentOSComment($input: CommentCreateInput!) {
          commentCreate(input: $input) { success }
        }`,
        { input: { issueId: issue.id, body: markedBody } }
      );
      return "created";
    }
  }

  async move(issueIdentifierOrId: string, stateName: string): Promise<void> {
    const issue = await this.findIssueReference(issueIdentifierOrId);
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

  async findIssueReference(issueIdentifierOrId: string): Promise<LinearIssueReference> {
    const trimmed = issueIdentifierOrId.trim();
    const filter = {
      ...(isLinearIdentifier(trimmed) ? identifierFilter(trimmed) : { id: { eq: trimmed } }),
      project: projectFilter(this.projectSlug)
    };
    const data = await this.request<{ issues: { nodes: LinearIssueReference[] } }>(
      `query AgentOSFindIssue($filter: IssueFilter) {
        issues(filter: $filter, first: 1) {
          nodes { id identifier state { name } team { id key name } }
        }
      }`,
      { filter }
    );
    const issue = data.issues.nodes[0];
    if (!issue) throw new Error(`Linear issue not found: ${issueIdentifierOrId}`);
    return {
      ...issue,
      state: String((issue as unknown as { state?: { name?: string } }).state?.name ?? issue.state ?? "")
    };
  }

  private async listIssueComments(issueId: string): Promise<Array<{ id: string; body: string }>> {
    const data = await this.request<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
      `query AgentOSIssueComments($id: String!) {
        issue(id: $id) {
          comments(first: 50) { nodes { id body } }
        }
      }`,
      { id: issueId }
    );
    return data.issue.comments.nodes;
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
      const details = await response.text().catch(() => "");
      throw new Error(`linear_api_status: ${response.status}${details ? ` ${details.slice(0, 300)}` : ""}`);
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

  private async fetchIssues(filter: Record<string, unknown>, first = 100): Promise<Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;
    do {
      const data: IssueConnection = await this.request<IssueConnection>(issueQuery("AgentOSIssues"), {
        filter,
        first,
        after
      });
      issues.push(...data.issues.nodes.map(normalizeLinearIssue));
      const pageInfo: IssueConnection["issues"]["pageInfo"] = data.issues.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      if (!pageInfo.endCursor) {
        throw new Error("linear_missing_end_cursor");
      }
      after = pageInfo.endCursor;
    } while (after);
    return issues;
  }
}

export function linearCommentMarker(key: string): string {
  return `<!-- agentos:event=${key} -->`;
}

export function isLinearIdentifier(value: string): boolean {
  return /^[A-Z][A-Z0-9]*-\d+$/i.test(value.trim());
}

function identifierFilter(identifier: string): Record<string, unknown> {
  const [teamKey, number] = identifier.trim().toUpperCase().split("-");
  return {
    team: { key: { eq: teamKey } },
    number: { eq: Number.parseInt(number, 10) }
  };
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
        .filter((relation: any) => isBlockedByRelation(relation.type))
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

function issueQuery(operationName: string): string {
  return `
    query ${operationName}($filter: IssueFilter, $first: Int!, $after: String) {
      issues(filter: $filter, first: $first, after: $after) {
        nodes {
          ${issueNodeSelection}
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
}

function projectFilter(projectSlugOrName: string): Record<string, unknown> {
  return {
    or: [{ slugId: { eq: projectSlugOrName } }, { name: { eq: projectSlugOrName } }]
  };
}

function isBlockedByRelation(type: unknown): boolean {
  const normalized = String(type ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized === "blocked_by" || normalized === "blockedby" || normalized === "is_blocked_by";
}
