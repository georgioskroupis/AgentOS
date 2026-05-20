export const harnessProfiles = ["base", "typescript", "python", "web", "api"] as const;

export type HarnessProfile = (typeof harnessProfiles)[number];
export type TrustMode = "review-only" | "ci-locked" | "local-trusted" | "danger";
export type GitHubMergeMode = "manual" | "shepherd" | "auto";
export type CodexEventPolicy = "deny" | "allow";
export type LifecycleMode = "orchestrator-owned" | "hybrid" | "agent-owned";
export type LifecycleDuplicateCommentBehavior = "upsert" | "skip" | "error";
export type AutomationProfile = "conservative" | "high-throughput";
export type AutomationRepairPolicy = "conservative" | "mechanical-first";
export type PullRequestRole = "primary" | "supporting" | "docs" | "follow-up" | "do-not-merge";
export type ReviewTargetMode = "merge-eligible" | "primary";
export type MergeTargetMode = "primary";
export type HumanDecisionType = "approve_as_is" | "fix_findings" | "accept_risk" | "split_follow_up" | "proceed_to_merge_after_supervisor_fix";
export type HumanDecisionFindingsState = "resolved" | "accepted" | "open" | "unknown";
export type ContextBudgetTurnKind = "implementation" | "reviewer" | "fixer";

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
    maxConcurrency?: number;
    pollingIntervalMs?: number;
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
  assignee?: string | null;
  assigneeId?: string | null;
  assigneeEmail?: string | null;
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
  automation: {
    profile: AutomationProfile;
    repairPolicy: AutomationRepairPolicy;
  };
  lifecycle: {
    mode: LifecycleMode;
    allowedTrackerTools: string[];
    idempotencyMarkerFormat: string | null;
    allowedStateTransitions: string[];
    duplicateCommentBehavior: LifecycleDuplicateCommentBehavior | null;
    fallbackBehavior: string | null;
    maturityAcknowledgement: string | null;
    trustedDecisionActors: string[];
  };
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
  contextBudget: ContextBudgetConfig;
  validationBudget: ValidationBudgetConfig;
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
    mergeTarget?: MergeTargetMode;
    baseBranch: string;
  };
  daemon: {
    mainBranchRefreshIntervalTicks: number;
  };
  review: {
    enabled: boolean;
    targetMode?: ReviewTargetMode;
    maxIterations: number;
    requiredReviewers: string[];
    optionalReviewers: string[];
    requireAllBlockingResolved: boolean;
    blockingSeverities: Array<"P0" | "P1" | "P2">;
    parallelReviewers: boolean;
    maxConcurrentReviewers: number;
    skipOptionalReviewersAfterBlockingRequired: boolean;
    budget: ReviewBudgetConfig;
  };
}

export interface ContextBudgetConfig {
  enabled: boolean;
  maxPromptTokens: number;
  maxCumulativeTokens: number;
  largeSectionTokens: number;
}

export interface ValidationBudgetConfig {
  enabled: boolean;
  fullValidationCommand: string;
  maxFullValidationRunsPerHead: number;
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
  status: "succeeded" | "failed" | "timed_out" | "stalled" | "canceled" | "stale";
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
  fetchIssueComments?(issueIdentifierOrId: string, limit?: number): Promise<IssueComment[]>;
  comment?(issueIdentifierOrId: string, body: string): Promise<void>;
  upsertComment?(issueIdentifierOrId: string, body: string, key: string): Promise<void>;
  move?(issueIdentifierOrId: string, stateName: string): Promise<void>;
}

export interface IssueComment {
  id: string;
  body: string;
  author?: string | null;
  authorId?: string | null;
  authorEmail?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type ScopeTextSource = "trusted_active_scope" | "issue_active_sections" | "issue_without_background" | "issue_full_text";

export interface ScopeScoreReasonState {
  reason: string;
  score: number;
}

export interface ScopePlanningReentryState {
  status: "not_required" | "satisfied" | "missing";
  reason: string;
  decisionCommentId?: string | null;
  activeScopePresent: boolean;
  activeScopeBounded: boolean;
  decompositionEvidencePresent: boolean;
}

export interface ScopeReportState {
  recordedAt: string;
  scopeSize: "small" | "medium" | "large" | "unclear";
  likelyLarge: boolean;
  score: number | null;
  largeThreshold: number;
  mediumThreshold: number;
  scoringTextSource: ScopeTextSource;
  scoringReasons: ScopeScoreReasonState[];
  ignoredSections: string[];
  planningReentry: ScopePlanningReentryState;
  dispatchAdvice: {
    shouldBlock: boolean;
    reason: string | null;
    nextSafeAction: string;
  };
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
  activeRunId?: string;
  retryAttempt?: number;
  nextRetryAt?: string;
  lastCodexEventAt?: string;
  stopReason?: string;
  workspacePath?: string;
  workspaceKey?: string;
  lifecycleStatus?: LifecycleStatus;
  terminalState?: string;
  terminalReason?: string;
  terminalAt?: string;
  humanContinuationAt?: string;
  mergedAt?: string;
  workspaceMissingAt?: string;
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
  humanDecisions?: HumanDecisionState[];
  lastHumanDecision?: HumanDecisionState | null;
  reviewTargetMode?: ReviewTargetMode;
  reviewTargetUrls?: string[];
  reviewRunnerFailures?: ReviewRunnerFailure[];
  reviewBudget?: ReviewBudgetState;
  splitRecommendation?: ReviewSplitRecommendation;
  mergeTargetUrl?: string | null;
  mergeTargetRole?: PullRequestRole | null;
  mergeCleanupWarnings?: string[];
  operatorRecovery?: OperatorRecoveryState;
  appProof?: AppProofState;
  scopeReport?: ScopeReportState;
  contextBudget?: ContextBudgetState;
  ciRetry?: CiRetryState;
  branchUpdate?: BranchUpdateState;
  validation?: ValidationState;
  updatedAt: string;
}

export interface ContextBudgetSectionState {
  name: string;
  estimatedTokens: number;
  chars: number;
  reason: string;
  large: boolean;
}

export interface ContextBudgetState {
  status: "within_budget" | "exceeded";
  evaluatedAt: string;
  runId?: string | null;
  kind: ContextBudgetTurnKind;
  estimatedPromptTokens: number;
  maxPromptTokens: number;
  cumulativeEstimatedTokens: number;
  maxCumulativeTokens: number;
  largeSectionTokens: number;
  sections: ContextBudgetSectionState[];
  exceededReasons?: string[];
  summary: string;
}

export interface PullRequestRef {
  url: string;
  discoveredAt: string;
  source: "handoff" | "legacy" | "manual";
  role?: PullRequestRole;
}

export interface AppProofState {
  updatedAt: string;
  artifacts: AppProofArtifact[];
}

export interface AppProofArtifact {
  label: string;
  value: string;
  source: "handoff" | "manual";
}

export interface CiRetryState {
  status: "requested" | "exhausted" | "failed";
  updatedAt: string;
  attempts: CiRetryAttemptState[];
}

export interface CiRetryAttemptState {
  status: "requested" | "exhausted" | "failed";
  attemptedAt: string;
  attempt: number;
  maxAttempts: number;
  prUrl: string;
  headSha?: string | null;
  checkNames: string[];
  runIds: string[];
  classification: "flaky_retryable";
  reason: string;
  error?: string;
}

export interface BranchUpdateState {
  status: "updated" | "report_only" | "failed";
  updatedAt: string;
  prUrl: string;
  reason: string;
  operatorGuidance: string;
  mergeStateStatus?: string | null;
  beforeHeadSha?: string | null;
  afterHeadSha?: string | null;
  error?: string;
}

export interface OperatorRecoveryState {
  recordedAt: string;
  runId?: string;
  branch: string;
  headSha: string;
  workspacePath: string;
  handoffPath: string;
  validationPath?: string;
  proofArtifacts: AppProofArtifact[];
  previousFailure?: {
    lastError?: string;
    stopReason?: string;
    retryAttempt?: number;
    nextRetryAt?: string;
    lifecycleStatus?: LifecycleStatus;
  };
}

export interface HumanDecisionState {
  type: HumanDecisionType;
  decidedAt: string;
  source: "linear-comment" | "handoff" | "manual";
  actor?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  trusted?: boolean;
  commentId?: string;
  body?: string;
  bodyTruncated?: boolean;
  prHeadSha?: string | null;
  validationEvidence?: string | null;
  ciState?: "passed" | "failed" | "pending" | "unknown" | null;
  findings?: HumanDecisionFindingsState;
  summary?: string;
}

export interface ValidationState {
  status: "passed" | "failed" | "missing";
  path?: string;
  runId?: string;
  repoHead?: string | null;
  errors?: string[];
  checkedAt: string;
  finalStatus?: "passed" | "failed";
  acceptedCommands?: ValidationCommandState[];
  additionalPassingCommands?: ValidationCommandState[];
  failedHistoricalAttempts?: ValidationCommandState[];
  githubCi?: ValidationCiState;
  budget?: ValidationBudgetState;
  reuseProfile?: ValidationReuseProfileState;
}

export interface ValidationCommandState {
  name: string;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
}

export interface ValidationCiState {
  status: "passed" | "failed" | "pending";
  headSha?: string | null;
  source?: string;
  checkedAt?: string;
  reused?: boolean;
}

export interface ValidationReuseProfileState {
  workflowConfigHash: string;
  trustMode: string;
  automationProfile: string;
  automationRepairPolicy: string;
  riskProfile: string;
}

export interface ValidationBudgetState {
  status: "fresh" | "reused" | "exceeded";
  evaluatedAt: string;
  fullValidationCommand: string;
  maxFullValidationRunsPerHead: number;
  fullValidationRunsForHead: number;
  repoHead?: string | null;
  currentRunId?: string | null;
  evidenceRunId?: string | null;
  summary: string;
}

export type RunPhase =
  | "workspace"
  | "prompt"
  | "app-server-init"
  | "streaming-turn"
  | "needs-input"
  | "human-required"
  | "validation"
  | "review"
  | "fix"
  | "merge"
  | "completed"
  | "canceled";

export type LifecycleStatus =
  | "implementation_failure"
  | "planning_required"
  | "review_escalation"
  | "human_continuation"
  | "supervisor_continuation"
  | "externally_fixed"
  | "merge_success"
  | "post_merge_cleanup_warning"
  | "terminal_linear"
  | "already_merged_pr"
  | "terminal_missing_workspace";

export type RunErrorCategory =
  | "workspace"
  | "prompt"
  | "app-server-init"
  | "streaming-turn"
  | "timeout"
  | "stall"
  | "canceled"
  | "capacity-wait"
  | "human-input"
  | "validation"
  | "review"
  | "fix";

export type ReviewStatus = "pending" | "approved" | "changes_requested" | "human_required";

export type ReviewBudgetMode = "recommend-only" | "prepare-draft";
export type ReviewBudgetSignalClassification = "mechanical" | "broad" | "non_mechanical";

export interface ReviewBudgetConfig {
  enabled: boolean;
  mode: ReviewBudgetMode;
  maxReviewElapsedMs: number;
  maxReviewIterations: number;
  maxFixerIterations: number;
  maxBlockingFindings: number;
  maxP1P2Findings: number;
  maxChangedFiles: number;
  maxValidationReruns: number;
  maxReviewTokens: number;
  repeatedBroadCategoryThreshold: number;
  lateNewBlockingFindingAfterApproval: boolean;
  broadCategories: string[];
}

export interface ReviewBudgetSignal {
  name: string;
  classification: ReviewBudgetSignalClassification;
  current: number;
  threshold?: number;
  summary: string;
}

export interface ReviewBudgetState {
  status: "within_budget" | "exceeded";
  mode: ReviewBudgetMode;
  evaluatedAt: string;
  summary: string;
  signals: ReviewBudgetSignal[];
}

export interface ReviewFollowUpProposal {
  title: string;
  body: string;
  artifactPath?: string;
}

export interface ReviewSplitRecommendation {
  recommended: boolean;
  action: ReviewBudgetMode;
  reason: string;
  summary: string;
  signals: ReviewBudgetSignal[];
  proposals?: ReviewFollowUpProposal[];
  recordedAt: string;
}

export interface ReviewStateReviewer {
  name: string;
  decision: ReviewStatus;
  iteration: number;
  artifactPath?: string;
  runId?: string;
  headSha?: string | null;
}

export type ReviewRunnerFailureClassification = "mechanical" | "non_mechanical";

export interface ReviewRunnerFailure {
  reviewer: string;
  iteration: number;
  attempt: number;
  maxAttempts: number;
  classification: ReviewRunnerFailureClassification;
  reason: string;
  message: string;
  artifactPath?: string;
  resultStatus?: string;
  runnerError?: string;
  retryable: boolean;
  exhausted: boolean;
  recordedAt: string;
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
