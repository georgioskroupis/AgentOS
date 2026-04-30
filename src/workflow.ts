import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { Liquid } from "liquidjs";
import { DEFAULT_CODEX_APP_SERVER_COMMAND } from "./defaults.js";
import { exists, readText } from "./fs-utils.js";
import { defaultThreadSandboxForTrustMode, defaultTurnSandboxPolicyForTrustMode, parseGitHubMergeMode, parseTrustMode, validateTrustCompatibility } from "./trust.js";
import type { Issue, ServiceConfig, WorkflowDefinition } from "./types.js";

const defaultActiveStates = ["Todo", "In Progress"];
const defaultTerminalStates = ["Closed", "Canceled", "Duplicate", "Done"];

export async function loadWorkflow(workflowPath: string): Promise<WorkflowDefinition> {
  const resolved = resolve(workflowPath);
  if (!(await exists(resolved))) {
    throw new Error(`missing_workflow_file: ${resolved}`);
  }
  const text = await readText(resolved);
  const { config, body } = parseWorkflowText(text);
  return {
    config,
    prompt_template: body.trim(),
    workflowPath: resolved
  };
}

export function parseWorkflowText(text: string): { config: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) {
    return { config: {}, body: text };
  }
  const end = text.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("workflow_parse_error: missing closing front matter marker");
  }
  const rawFrontMatter = text.slice(4, end);
  const body = text.slice(end + 4);
  const parsed = YAML.parse(rawFrontMatter) as unknown;
  if (parsed == null) {
    return { config: {}, body };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow_front_matter_not_a_map");
  }
  return { config: parsed as Record<string, unknown>, body };
}

export function resolveServiceConfig(workflow: WorkflowDefinition, env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const cfg = workflow.config;
  const tracker = objectAt(cfg, "tracker");
  const polling = objectAt(cfg, "polling");
  const workspace = objectAt(cfg, "workspace");
  const hooks = objectAt(cfg, "hooks");
  const agent = objectAt(cfg, "agent");
  const codex = objectAt(cfg, "codex");
  const github = objectAt(cfg, "github");
  const workflowDir = dirname(workflow.workflowPath);
  const trustMode = parseTrustMode(cfg.trust_mode);

  const trackerKind = stringAt(tracker, "kind", "linear");
  if (trackerKind !== "linear") {
    throw new Error(`unsupported_tracker_kind: ${trackerKind}`);
  }

  const apiKeyRaw = stringAt(tracker, "api_key", "$LINEAR_API_KEY");
  const apiKey = resolveEnvReference(apiKeyRaw, env);
  const projectSlug = stringAt(tracker, "project_slug", stringAt(tracker, "projectSlug", ""));

  return {
    trustMode,
    tracker: {
      kind: "linear",
      endpoint: stringAt(tracker, "endpoint", "https://api.linear.app/graphql"),
      apiKey,
      projectSlug,
      activeStates: stringListAt(tracker, "active_states", defaultActiveStates),
      terminalStates: stringListAt(tracker, "terminal_states", defaultTerminalStates),
      runningState: nullableStringAt(tracker, "running_state") ?? "In Progress",
      reviewState: nullableStringAt(tracker, "review_state") ?? "Human Review",
      mergeState: nullableStringAt(tracker, "merge_state"),
      needsInputState: nullableStringAt(tracker, "needs_input_state") ?? "Human Review"
    },
    polling: {
      intervalMs: positiveIntAt(polling, "interval_ms", 30_000)
    },
    workspace: {
      root: resolveLocalPath(stringAt(workspace, "root", ".agent-os/workspaces"), workflowDir, env)
    },
    hooks: {
      afterCreate: nullableStringAt(hooks, "after_create"),
      beforeRun: nullableStringAt(hooks, "before_run"),
      afterRun: nullableStringAt(hooks, "after_run"),
      beforeRemove: nullableStringAt(hooks, "before_remove"),
      timeoutMs: positiveIntAt(hooks, "timeout_ms", 60_000)
    },
    agent: {
      maxConcurrentAgents: positiveIntAt(agent, "max_concurrent_agents", 10),
      maxTurns: positiveIntAt(agent, "max_turns", 20),
      maxRetryAttempts: positiveIntAt(agent, "max_retry_attempts", 3),
      maxRetryBackoffMs: positiveIntAt(agent, "max_retry_backoff_ms", 300_000),
      maxConcurrentAgentsByState: stateConcurrencyMap(agent.max_concurrent_agents_by_state)
    },
    codex: {
      command: stringAt(codex, "command", DEFAULT_CODEX_APP_SERVER_COMMAND),
      approvalPolicy: codex.approval_policy,
      threadSandbox: codex.thread_sandbox ?? defaultThreadSandboxForTrustMode(trustMode),
      turnSandboxPolicy: codex.turn_sandbox_policy ?? defaultTurnSandboxPolicyForTrustMode(trustMode),
      turnTimeoutMs: positiveIntAt(codex, "turn_timeout_ms", 3_600_000),
      readTimeoutMs: positiveIntAt(codex, "read_timeout_ms", 5_000),
      stallTimeoutMs: intAt(codex, "stall_timeout_ms", 300_000),
      passThrough: { ...codex }
    },
    github: {
      command: stringAt(github, "command", "gh"),
      mergeMode: parseGitHubMergeMode(github.merge_mode),
      mergeMethod: mergeMethodAt(github, "merge_method", "squash"),
      requireChecks: booleanAt(github, "require_checks", true),
      deleteBranch: booleanAt(github, "delete_branch", true),
      doneState: stringAt(github, "done_state", "Done"),
      allowHumanMergeOverride: booleanAt(github, "allow_human_merge_override", false)
    },
    review: {
      enabled: booleanAt(objectAt(cfg, "review"), "enabled", true),
      maxIterations: positiveIntAt(objectAt(cfg, "review"), "max_iterations", 3),
      requiredReviewers: stringListAt(objectAt(cfg, "review"), "required_reviewers", ["self", "correctness", "tests", "architecture"]),
      optionalReviewers: stringListAt(objectAt(cfg, "review"), "optional_reviewers", ["security"]),
      requireAllBlockingResolved: booleanAt(objectAt(cfg, "review"), "require_all_blocking_resolved", true),
      blockingSeverities: blockingSeveritiesAt(objectAt(cfg, "review"), "blocking_severities", ["P0", "P1", "P2"])
    }
  };
}

export function validateDispatchConfig(config: ServiceConfig): void {
  if (!config.tracker.kind) throw new Error("tracker.kind is required");
  if (!config.tracker.apiKey) throw new Error("tracker.api_key is required after environment resolution");
  if (!config.tracker.projectSlug) throw new Error("tracker.project_slug is required");
  if (!config.codex.command) throw new Error("codex.command is required");
}

export interface WorkflowValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateWorkflowDefinition(workflow: WorkflowDefinition, env: NodeJS.ProcessEnv = process.env, strict = false): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let config: ServiceConfig | null = null;
  try {
    config = resolveServiceConfig(workflow, env);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!config) return { ok: false, errors, warnings };
  if (!config.tracker.projectSlug) errors.push("tracker.project_slug is required");
  if (!config.tracker.activeStates.length) errors.push("tracker.active_states must include at least one state");
  if (!config.tracker.terminalStates.length) errors.push("tracker.terminal_states must include at least one state");
  if (!workflow.prompt_template.trim()) warnings.push("workflow prompt template is empty");
  if (config.github.requireChecks === false) warnings.push("github.require_checks is disabled");
  const trust = validateTrustCompatibility({
    trustMode: config.trustMode,
    githubMergeMode: config.github.mergeMode,
    turnSandboxPolicy: config.codex.turnSandboxPolicy,
    reviewEnabled: config.review.enabled
  });
  errors.push(...trust.errors);
  warnings.push(...trust.warnings);

  if (strict) {
    if (!config.tracker.apiKey) errors.push("tracker.api_key did not resolve from the environment");
    if (/@latest\b/.test(config.codex.command)) errors.push("codex.command must be pinned in strict mode");
    if (config.github.allowHumanMergeOverride) errors.push("github.allow_human_merge_override must be false in strict mode");
    for (const state of ["Done", "Canceled", "Duplicate"]) {
      if (!config.tracker.terminalStates.some((candidate) => candidate.toLowerCase() === state.toLowerCase())) {
        errors.push(`tracker.terminal_states should include ${state} in strict mode`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export async function renderPrompt(template: string, issue: Issue, attempt: number | null): Promise<string> {
  if (!template.trim()) {
    return "You are working on an issue from Linear.";
  }
  const liquid = new Liquid({
    strictVariables: true,
    strictFilters: true,
    lenientIf: false
  });
  return liquid.parseAndRender(template, { issue, attempt });
}

function objectAt(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const found = value[key];
  if (!found || typeof found !== "object" || Array.isArray(found)) {
    return {};
  }
  return found as Record<string, unknown>;
}

function stringAt(value: Record<string, unknown>, key: string, fallback: string): string {
  const found = value[key];
  return typeof found === "string" ? found : fallback;
}

function nullableStringAt(value: Record<string, unknown>, key: string): string | null {
  const found = value[key];
  return typeof found === "string" && found.trim() ? found : null;
}

function stringListAt(value: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const found = value[key];
  return Array.isArray(found) && found.every((item) => typeof item === "string") ? found : fallback;
}

function positiveIntAt(value: Record<string, unknown>, key: string, fallback: number): number {
  const raw = value[key];
  const num = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

function intAt(value: Record<string, unknown>, key: string, fallback: number): number {
  const raw = value[key];
  const num = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(num) ? num : fallback;
}

function booleanAt(value: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const found = value[key];
  return typeof found === "boolean" ? found : fallback;
}

function mergeMethodAt(value: Record<string, unknown>, key: string, fallback: "squash" | "merge" | "rebase"): "squash" | "merge" | "rebase" {
  const found = value[key];
  return found === "squash" || found === "merge" || found === "rebase" ? found : fallback;
}

function blockingSeveritiesAt(value: Record<string, unknown>, key: string, fallback: Array<"P0" | "P1" | "P2">): Array<"P0" | "P1" | "P2"> {
  const found = value[key];
  if (!Array.isArray(found)) return fallback;
  const severities = found.filter((item): item is "P0" | "P1" | "P2" => item === "P0" || item === "P1" || item === "P2");
  return severities.length > 0 ? severities : fallback;
}

function stateConcurrencyMap(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [state, raw] of Object.entries(value)) {
    const num = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (Number.isInteger(num) && num > 0) {
      out.set(state.toLowerCase(), num);
    }
  }
  return out;
}

function resolveEnvReference(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.startsWith("$")) return value;
  return env[value.slice(1)] ?? "";
}

function resolveLocalPath(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
  let expanded = value.replace(/^~(?=$|\/)/, env.HOME ?? "");
  expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => env[name] ?? "");
  return resolve(baseDir, expanded);
}
