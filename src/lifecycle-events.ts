export const lifecycleActors = ["agent", "scheduler_safety", "extension", "supervisor"] as const;
export type LifecycleActor = (typeof lifecycleActors)[number];

export const lifecycleEventTypes = [
  "run_started",
  "progress_comment",
  "pr_metadata_recorded",
  "handoff_recorded",
  "state_transition_requested",
  "review_ready",
  "scheduler_safety_write_requested",
  "evidence_verification_failed"
] as const;
export type LifecycleEventType = (typeof lifecycleEventTypes)[number];

export const lifecycleEventSources = ["orchestrator", "repo_tool", "client_tool", "extension", "supervisor"] as const;
export type LifecycleEventSource = (typeof lifecycleEventSources)[number];

export const schedulerSafetyWriteReasons = [
  "bootstrap_failed_before_agent_start",
  "pre_dispatch_safety_block",
  "retry_budget_exhausted",
  "stale_run_recovery_required",
  "terminal_cleanup_reconciliation",
  "agent_owned_lifecycle_missing_evidence"
] as const;
export type SchedulerSafetyWriteReason = (typeof schedulerSafetyWriteReasons)[number];

export interface LifecycleEvent {
  schemaVersion: 1;
  actor: LifecycleActor;
  type: LifecycleEventType;
  issueId: string;
  issueIdentifier: string;
  source: LifecycleEventSource;
  createdAt: string;
  runId?: string;
  attempt?: number | null;
  requestedState?: string;
  safetyReason?: SchedulerSafetyWriteReason;
  marker?: string;
  artifactPath?: string;
}

export interface LifecycleController {
  record(event: LifecycleEvent): Promise<void>;
}
