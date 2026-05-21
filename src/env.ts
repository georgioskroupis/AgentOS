import { join } from "node:path";
import { exists, readText } from "./fs-utils.js";
import type { ServiceConfig } from "./types.js";

export type RepoEnvStatus = "missing" | "loaded" | "malformed" | "stale";
export type DaemonPreflightStatus = "ready" | "missing_credentials" | "malformed_env" | "stale_env" | "singleton_conflict";
export type CredentialAvailability = "present" | "missing" | "unchecked";

export interface RepoEnvLoadResult {
  path: string;
  status: RepoEnvStatus;
  values: Record<string, string>;
  loadedKeys: string[];
  errors: string[];
}

export interface ResolvedRepoEnv {
  env: NodeJS.ProcessEnv;
  repoEnv: RepoEnvLoadResult;
}

export interface DaemonPreflightResult {
  status: DaemonPreflightStatus;
  message: string;
  repoEnvPath: string;
  repoEnvStatus: RepoEnvStatus;
  loadedKeys: string[];
  errors: string[];
  tracker: {
    linearApiKey: "present" | "missing";
    projectSlug: "present" | "missing";
  };
  github: {
    command: "configured" | "missing";
    required: boolean;
    auth: CredentialAvailability;
  };
  codex: {
    command: "configured" | "missing";
  };
}

export async function resolveRepoEnv(repoRoot: string, baseEnv: NodeJS.ProcessEnv = process.env): Promise<ResolvedRepoEnv> {
  const repoEnv = await loadRepoEnv(repoRoot);
  return {
    env: { ...baseEnv, ...repoEnv.values },
    repoEnv
  };
}

export async function loadRepoEnv(repoRoot: string): Promise<RepoEnvLoadResult> {
  const path = join(repoRoot, ".agent-os", "env");
  if (!(await exists(path))) {
    return { path, status: "missing", values: {}, loadedKeys: [], errors: [] };
  }
  const text = await readText(path);
  const parsed = parseEnvText(text);
  const status: RepoEnvStatus = parsed.errors.length
    ? "malformed"
    : isStaleLinearCredential(parsed.values.LINEAR_API_KEY)
      ? "stale"
      : "loaded";
  return {
    path,
    status,
    values: parsed.values,
    loadedKeys: Object.keys(parsed.values).sort(),
    errors: parsed.errors
  };
}

export function daemonPreflight(config: ServiceConfig, repoEnv: RepoEnvLoadResult): DaemonPreflightResult {
  const errors = [...repoEnv.errors];
  const trackerApiKey = config.tracker.apiKey ? "present" : "missing";
  const projectSlug = config.tracker.projectSlug ? "present" : "missing";
  const githubRequired = config.github.mergeMode !== "manual";
  const githubCommand = config.github.command ? "configured" : "missing";
  const codexCommand = config.codex.command ? "configured" : "missing";
  if (trackerApiKey === "missing") errors.push("tracker.api_key is required after environment resolution");
  if (projectSlug === "missing") errors.push("tracker.project_slug is required");
  if (githubRequired && githubCommand === "missing") errors.push("github.command is required for merge shepherding");
  if (codexCommand === "missing") errors.push("codex.command is required");

  const status: DaemonPreflightStatus = repoEnv.status === "malformed"
    ? "malformed_env"
    : repoEnv.status === "stale"
      ? "stale_env"
      : errors.length
        ? "missing_credentials"
        : "ready";
  return {
    status,
    message: preflightMessage(status, repoEnv, errors),
    repoEnvPath: repoEnv.path,
    repoEnvStatus: repoEnv.status,
    loadedKeys: repoEnv.loadedKeys,
    errors,
    tracker: {
      linearApiKey: trackerApiKey,
      projectSlug
    },
    github: {
      command: githubCommand,
      required: githubRequired,
      auth: "unchecked"
    },
    codex: {
      command: codexCommand
    }
  };
}

export function withGitHubCredentialPreflight(
  result: DaemonPreflightResult,
  auth: Extract<CredentialAvailability, "present" | "missing">
): DaemonPreflightResult {
  const errors =
    auth === "missing"
      ? [
          ...result.errors,
          "github.auth is required for high-throughput landing; run `gh auth login` or provide a valid GH_TOKEN/GITHUB_TOKEN for the configured github.command"
        ]
      : result.errors;
  const status: DaemonPreflightStatus =
    result.status === "ready" && auth === "missing"
      ? "missing_credentials"
      : result.status;
  const next = {
    ...result,
    status,
    errors,
    github: {
      ...result.github,
      auth
    }
  };
  return {
    ...next,
    message: preflightMessage(status, { path: result.repoEnvPath, status: result.repoEnvStatus, values: {}, loadedKeys: result.loadedKeys, errors: [] }, errors)
  };
}

export function preflightAllowsDispatch(result: DaemonPreflightResult): boolean {
  return result.status === "ready";
}

function parseEnvText(text: string): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      errors.push(`line ${index + 1}: expected KEY=VALUE`);
      return;
    }
    values[match[1]] = unquoteEnvValue(match[2].trim());
  });
  return { values, errors };
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isStaleLinearCredential(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized === "change_me" || normalized === "changeme" || normalized === "todo" || normalized.includes("placeholder");
}

function preflightMessage(status: DaemonPreflightStatus, repoEnv: RepoEnvLoadResult, errors: string[]): string {
  if (status === "ready") {
    return repoEnv.status === "loaded" ? `loaded repo env from ${repoEnv.path}` : "required daemon credentials are available";
  }
  if (status === "malformed_env") return `.agent-os/env is malformed: ${errors.join("; ")}`;
  if (status === "stale_env") return `.agent-os/env contains stale or placeholder credentials`;
  return errors.length ? errors.join("; ") : "required daemon credentials are missing";
}
