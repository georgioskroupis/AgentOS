export const harnessProfiles = ["base", "typescript", "python", "web", "api"] as const;

export type HarnessProfile = (typeof harnessProfiles)[number];

export interface HarnessChange {
  action: "add" | "overwrite" | "exists" | "missing";
  path: string;
  source?: string;
}

export interface ProjectRegistry {
  version: 1;
  defaults?: {
    prProvider?: "github";
    workspaceRoot?: string;
  };
  projects: ProjectConfig[];
}

export interface ProjectConfig {
  name: string;
  repo: string;
  workflow?: string;
  harnessProfile?: HarnessProfile;
  tracker?: {
    kind: "linear";
    projectSlug: string;
  };
  maxConcurrency?: number;
}

export interface IssueRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: IssueRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
  workflowPath: string;
}

export interface ServiceConfig {
  tracker: {
    kind: "linear";
    endpoint: string;
    apiKey: string;
    projectSlug: string;
    activeStates: string[];
    terminalStates: string[];
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxTurns: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Map<string, number>;
  };
  codex: {
    command: string;
    approvalPolicy?: unknown;
    threadSandbox?: unknown;
    turnSandboxPolicy?: unknown;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
    passThrough: Record<string, unknown>;
  };
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface AgentEvent {
  type: string;
  issueId?: string;
  issueIdentifier?: string;
  message?: string;
  payload?: unknown;
  timestamp: string;
}

export interface AgentRunResult {
  status: "succeeded" | "failed" | "timed_out" | "stalled" | "canceled";
  threadId?: string;
  turnId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  error?: string;
}

export interface AgentRunner {
  run(input: {
    issue: Issue;
    prompt: string;
    attempt: number | null;
    workspace: Workspace;
    config: ServiceConfig;
    onEvent: (event: AgentEvent) => void;
    signal?: AbortSignal;
  }): Promise<AgentRunResult>;
}

export interface IssueTracker {
  fetchCandidates(activeStates: string[]): Promise<Issue[]>;
  fetchIssueStates(issueIds: string[]): Promise<Map<string, Issue | null>>;
  fetchTerminalIssues?(terminalStates: string[]): Promise<Issue[]>;
}

