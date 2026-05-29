import { relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export type MonitorTimeClass = "agent" | "validation" | "scheduler" | "external-wait" | "human-wait" | "tool";
export type MonitorStatus = "active" | "done" | "failed" | "waiting" | "pass" | "skipped";
export type MonitorValidationStatus = "pass" | "fail" | "skipped";
export type MonitorChangedSurface = "docs" | "workflow-config" | "architecture-check" | "ui" | "tests" | "source" | "unknown";
export const monitorActivityKinds = ["command_output", "file_change", "token_usage", "rate_limit", "generic"] as const;
export type MonitorActivityKind = (typeof monitorActivityKinds)[number];
export type MonitorRateLimitPressure = "none" | "low" | "medium" | "high" | "blocked";
export type MonitorHumanActionReasonCode =
  | "none"
  | "validation_failed"
  | "ci_failed"
  | "review_findings"
  | "architecture_check_failed"
  | "workflow_config_changed"
  | "human_review"
  | "needs_input"
  | "planning_required"
  | "recovery_needed"
  | "blocked"
  | "capacity_wait"
  | "unknown";

export type MonitorActivity =
  | {
      kind: "command_output";
      label: string;
      command?: string;
      stream?: "stdout" | "stderr";
      bytesObserved?: number;
    }
  | {
      kind: "file_change";
      label: string;
      changedFileCount?: number;
      lastFile?: string;
      category: MonitorFileActivityCategory;
    }
  | {
      kind: "token_usage";
      label: string;
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
    }
  | {
      kind: "rate_limit";
      label: string;
      pressure: MonitorRateLimitPressure;
      resetAt?: string;
    }
  | {
      kind: "generic";
      label: string;
    };

export type MonitorActivityInput = Record<string, unknown> & {
  kind: MonitorActivityKind;
};

export type MonitorFileActivityCategory = "source" | "test" | "docs" | "config" | "unknown";

export type MonitorFileActivitySummary = {
  changedFileCount?: number;
  lastFile?: string;
  category: MonitorFileActivityCategory;
};

export type MonitorSink = {
  emit(event: MonitorEvent): void | Promise<void>;
};

export class NullMonitorSink implements MonitorSink {
  emit(_event: MonitorEvent): void {}
}

export type MonitorEvent = {
  eventId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  turnId?: string;
  issueId?: string;
  timestamp: string;
  kind:
    | "run_started"
    | "run_finished"
    | "run_failed"
    | "stage_started"
    | "stage_finished"
    | "step_started"
    | "step_finished"
    | "wait_started"
    | "wait_finished"
    | "loop_started"
    | "loop_finished"
    | "loop_iteration_started"
    | "loop_iteration_finished"
    | "model_started"
    | "model_finished"
    | "validation_started"
    | "validation_finished"
    | "activity_observed"
    | "human_action_required";
  label: string;
  status?: MonitorStatus;
  timeClass?: MonitorTimeClass;
  model?: { name: string; role: "implementation" | "review" | "fix" | "summary" | "validation" | "other" };
  iteration?: { current: number; max?: number; label: string };
  validation?: { command: string; durationMs?: number; status: MonitorValidationStatus; exitCode?: number };
  humanAction?: {
    reasonCode?: MonitorHumanActionReasonCode;
    changedSurfaces?: MonitorChangedSurface[];
    changedFiles?: string[];
    details?: string;
  };
  activity?: MonitorActivity;
  result?: string;
};

export function buildMonitorActivity(input: MonitorActivityInput): MonitorActivity {
  const label = compactActivityString(input.label) ?? defaultActivityLabel(input.kind);
  if (input.kind === "command_output") {
    return {
      kind: input.kind,
      label,
      ...(compactActivityString(input.command) ? { command: compactActivityString(input.command) } : {}),
      ...(monitorActivityStream(input.stream) ? { stream: monitorActivityStream(input.stream) } : {}),
      ...(nonNegativeInteger(input.bytesObserved ?? input.byteCount) != null ? { bytesObserved: nonNegativeInteger(input.bytesObserved ?? input.byteCount)! } : {})
    };
  }
  if (input.kind === "file_change") {
    const changedFileCount = nonNegativeInteger(input.changedFileCount ?? input.fileCount);
    const lastFile = repoRelativeActivityPath(input.lastFile ?? input.path);
    const category = monitorFileCategory(input.category) ?? categoryForActivityPath(lastFile);
    return {
      kind: input.kind,
      label,
      ...(changedFileCount != null ? { changedFileCount } : {}),
      ...(lastFile ? { lastFile } : {}),
      category
    };
  }
  if (input.kind === "token_usage") {
    return {
      kind: input.kind,
      label,
      ...(nonNegativeInteger(input.totalTokens) != null ? { totalTokens: nonNegativeInteger(input.totalTokens)! } : {}),
      ...(nonNegativeInteger(input.inputTokens) != null ? { inputTokens: nonNegativeInteger(input.inputTokens)! } : {}),
      ...(nonNegativeInteger(input.outputTokens) != null ? { outputTokens: nonNegativeInteger(input.outputTokens)! } : {})
    };
  }
  if (input.kind === "rate_limit") {
    return {
      kind: input.kind,
      label,
      pressure: monitorRateLimitPressure(input.pressure) ?? "none",
      ...(compactActivityString(input.resetAt) ? { resetAt: compactActivityString(input.resetAt) } : {})
    };
  }
  return {
    kind: input.kind,
    label
  };
}

function compactActivityString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return redactKnownEnvValues(trimmed).slice(0, 160);
}

function redactKnownEnvValues(value: string): string {
  let redacted = value;
  for (const [key, envValue] of Object.entries(process.env)) {
    if (!envValue || envValue.length < 8 || !/(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|PRIVATE_KEY)/i.test(key)) continue;
    redacted = redacted.split(envValue).join("[REDACTED]");
  }
  return redacted;
}

function defaultActivityLabel(kind: MonitorActivityKind): string {
  if (kind === "command_output") return "Command output observed";
  if (kind === "file_change") return "File activity observed";
  if (kind === "token_usage") return "Token usage observed";
  if (kind === "rate_limit") return "Rate-limit pressure observed";
  return "Activity observed";
}

function monitorActivityStream(value: unknown): "stdout" | "stderr" | undefined {
  return value === "stdout" || value === "stderr" ? value : undefined;
}

function monitorFileCategory(value: unknown): MonitorFileActivityCategory | undefined {
  return value === "source" || value === "test" || value === "docs" || value === "config" || value === "unknown" ? value : undefined;
}

function monitorRateLimitPressure(value: unknown): MonitorRateLimitPressure | undefined {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "blocked" ? value : undefined;
}

function repoRelativeActivityPath(value: unknown): string | undefined {
  const compact = compactActivityString(value);
  if (!compact || looksLikeRawDiff(compact)) return undefined;

  const normalized = normalizeSeparators(compact);
  if (normalized.startsWith("~")) return undefined;
  if (normalized.startsWith("/")) return normalizeAbsoluteActivityPath(normalized);
  if (hasUnsafeSegments(normalized)) return undefined;
  if (looksUserSpecificOrTempRelative(normalized)) return undefined;
  return normalized;
}

function normalizeAbsoluteActivityPath(value: string): string | undefined {
  for (const root of activityPathRoots()) {
    const relativePath = normalizeRelativeFromRoot(root, value);
    if (relativePath) return relativePath;
  }
  return undefined;
}

function activityPathRoots(): string[] {
  return [...new Set([process.cwd(), process.env.AGENT_OS_WORKSPACE, process.env.AGENTOS_WORKSPACE].filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function normalizeRelativeFromRoot(root: string, value: string): string | undefined {
  const resolvedRoot = resolve(root);
  const resolvedValue = resolve(value);
  if (resolvedValue !== resolvedRoot && !resolvedValue.startsWith(`${resolvedRoot}${sep}`)) return undefined;
  const relativePath = normalizeSeparators(relative(resolvedRoot, resolvedValue));
  return relativePath && relativePath !== "." && !hasUnsafeSegments(relativePath) ? relativePath : undefined;
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function hasUnsafeSegments(value: string): boolean {
  return value.split("/").some((segment) => segment === ".." || segment === "");
}

function looksUserSpecificOrTempRelative(value: string): boolean {
  const lowered = value.toLowerCase();
  const tempRoot = normalizeSeparators(tmpdir()).replace(/^\//, "").toLowerCase();
  return lowered.startsWith("users/") || lowered.startsWith("home/") || lowered.startsWith("var/folders/") || lowered.startsWith("tmp/") || lowered.startsWith(`${tempRoot}/`);
}

function looksLikeRawDiff(value: string): boolean {
  return /(^|\s)(diff --git|@@ |\+\+\+ |--- |\*\*\* Begin Patch|\*\*\* End Patch)/.test(value);
}

function categoryForActivityPath(path: string | undefined): MonitorFileActivityCategory {
  if (!path) return "unknown";
  const lowered = path.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(lowered) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(lowered)) return "test";
  if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+|eslint[^/]*|prettier[^/]*)$/.test(lowered)) return "config";
  if (lowered.startsWith(".github/") || lowered.startsWith(".agent-os/") || lowered === "workflow.md" || lowered === "agents.md") return "config";
  if (lowered.startsWith("docs/") || /\.mdx?$/.test(lowered)) return "docs";
  if (lowered.startsWith("src/") || /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|cs|php|css|scss|html)$/.test(lowered)) return "source";
  return "unknown";
}

function nonNegativeInteger(value: unknown): number | undefined {
  const numeric = integerValue(value);
  return numeric != null && numeric >= 0 ? numeric : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) ? value : undefined;
}
