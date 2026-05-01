export const harnessProfiles = ["base", "typescript", "python", "web", "api"] as const;

export type HarnessProfile = (typeof harnessProfiles)[number];
export type TrustMode = "review-only" | "ci-locked" | "local-trusted" | "danger";
export type GitHubMergeMode = "manual" | "shepherd" | "auto";
export type CodexEventPolicy = "deny" | "allow";

export interface HarnessChange {
  action: "add" | "overwrite" | "exists" | "missing" | "invalid";
  path: string;
  source?: string;
  message?: string;
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
  trustMode: TrustMode;
  tracker: {
    kind: "linear";
    endpoint: string;
    apiKey: string;
    projectSlug: string;
    activeStates: string[];
    terminalStates: string[];
    runningState: string | null;
    reviewState: string | null;
    mergeState: string | null;
    needsInputState: string | null;
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
    maxRetryAttempts: number;
    maxRetryBackoffMs: number;
    maxConcurrentAgentsByState: Map<string, number>;
  };
  codex: {
    command: string;
    approvalPolicy?: unknown;
    approvalEventPolicy: CodexEventPolicy;
    userInputPolicy: CodexEventPolicy;
    threadSandbox?: unknown;
    turnSandboxPolicy?: unknown;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
    passThrough: Record<string, unknown>;
  };
  github: {
    command: string;
    mergeMode: GitHubMergeMode;
    mergeMethod: "squash" | "merge" | "rebase";
    requireChecks: boolean;
    deleteBranch: boolean;
    doneState: string;
    allowHumanMergeOverride: boolean;
  };
  review: {
    enabled: boolean;
    maxIterations: number;
    requiredReviewers: string[];
    optionalReviewers: string[];
    requireAllBlockingResolved: boolean;
    blockingSeverities: Array<"P0" | "P1" | "P2">;
  };
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
  lockPath?: string;
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
  rateLimits?: Array<Record<string, unknown>>;
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
  comment?(issueIdentifierOrId: string, body: string): Promise<void>;
  upsertComment?(issueIdentifierOrId: string, body: string, key: string): Promise<void>;
  move?(issueIdentifierOrId: string, stateName: string): Promise<void>;
}

export interface IssueState {
  schemaVersion: 1;
  issueId: string;
  issueIdentifier: string;
  prs?: PullRequestRef[];
  /** @deprecated Use prs[0].url. Preserved for lazy migration compatibility. */
  prUrl?: string;
  outcome?: "implemented" | "already_satisfied" | "partially_satisfied";
  phase?: RunPhase;
  lastRunId?: string;
  errorCategory?: RunErrorCategory;
  lastError?: string;
  nextRetryAt?: string;
  headSha?: string | null;
  reviewIteration?: number;
  reviewStatus?: ReviewStatus;
  reviewers?: ReviewStateReviewer[];
  findings?: ReviewFinding[];
  resolvedFindingHashes?: string[];
  lastReviewedSha?: string | null;
  lastFixedSha?: string | null;
  lastHumanFeedbackAt?: string | null;
  humanOverrideAt?: string | null;
  validation?: ValidationState;
  updatedAt: string;
}

export interface PullRequestRef {
  url: string;
  discoveredAt: string;
  source: "handoff" | "legacy" | "manual";
}

export interface ValidationState {
  status: "passed" | "failed" | "missing";
  path?: string;
  errors?: string[];
  checkedAt: string;
}

export type RunPhase =
  | "workspace"
  | "prompt"
  | "app-server-init"
  | "streaming-turn"
  | "validation"
  | "review"
  | "fix"
  | "merge"
  | "completed";

export type RunErrorCategory =
  | "workspace"
  | "prompt"
  | "app-server-init"
  | "streaming-turn"
  | "timeout"
  | "stall"
  | "canceled"
  | "validation"
  | "review"
  | "fix";

export type ReviewStatus = "pending" | "approved" | "changes_requested" | "human_required";

export interface ReviewStateReviewer {
  name: string;
  decision: ReviewStatus;
  iteration: number;
  artifactPath?: string;
}

export interface ReviewFinding {
  reviewer: string;
  decision: "approved" | "changes_requested" | "human_required";
  severity: "P0" | "P1" | "P2" | "P3";
  file?: string | null;
  line?: number | null;
  body: string;
  findingHash: string;
}
