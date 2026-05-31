import type { RunErrorCategory } from "./types.js";

export function isDispatchTerminalStop(error: string | undefined): boolean {
  return Boolean(
    error?.startsWith("issue_became_terminal:") ||
      error?.startsWith("issue_no_longer_dispatchable:") ||
      isDependencyDispatchStop(error) ||
      error === "issue_no_longer_exists" ||
      error === "pull_request_already_merged" ||
      error === "supervisor_continuation_active"
  );
}

export function isDependencyDispatchStop(error: string | undefined): boolean {
  return Boolean(error?.toLowerCase().startsWith("issue_blocked_by_dependency:"));
}

export function categorizeRunError(message: string): RunErrorCategory {
  const normalized = message.toLowerCase();
  if (normalized.includes("capacity_wait") || /\b(usage limit|rate limit|too many requests|quota)\b/.test(normalized)) return "capacity-wait";
  if (isHumanInputStop(normalized)) return "human-input";
  if (normalized.includes("codex_app_server_closed")) return "streaming-turn";
  if (normalized.includes("timeout")) return "timeout";
  if (normalized.includes("stall")) return "stall";
  if (normalized.includes("cancel")) return "canceled";
  if (normalized.includes("workspace") || normalized.includes("worktree")) return "workspace";
  if (normalized.includes("prompt") || normalized.includes("liquid")) return "prompt";
  if (normalized.includes("app_server") || normalized.includes("app-server") || normalized.includes("initialize")) return "app-server-init";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("fix")) return "fix";
  if (normalized.includes("validation") || normalized.includes("test") || normalized.includes("check")) return "validation";
  return "streaming-turn";
}

export function isHumanInputStop(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("codex_approval_request_denied") ||
    normalized.includes("codex_user_input_request_denied") ||
    normalized.includes("codex_elicitation_request_denied") ||
    normalized.includes("agent_pr_creation_failed") ||
    normalized.includes("nested_orchestrator_forbidden") ||
    normalized.includes("context_budget_exceeded")
  );
}
