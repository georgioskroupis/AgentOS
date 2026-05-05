import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, readText } from "./fs-utils.js";
import { IssueStateStore, normalizeIssueState, pullRequestUrls } from "./issue-state.js";
import { JsonlLogger } from "./logging.js";
import { loadRegistry, RegistryStateStore, resolveRegistryProjectPaths, type RegistryProjectSummary } from "./registry.js";
import { RuntimeStateStore } from "./runtime-state.js";
import { loadWorkflow, resolveServiceConfig } from "./workflow.js";
import type { IssueState, ValidationCommandState, ValidationState } from "./types.js";

export async function getStatus(repo = process.cwd(), limit = 20): Promise<string> {
  const logger = new JsonlLogger(resolve(repo));
  const entries = await logger.tail(limit);
  if (entries.length === 0) {
    return "No AgentOS run events recorded.";
  }
  return entries
    .map((entry) => {
      const issue = entry.issueIdentifier ? ` ${entry.issueIdentifier}` : "";
      const message = entry.message ? ` - ${entry.message}` : "";
      return `${entry.timestamp} ${entry.type}${issue}${message}`;
    })
    .join("\n");
}

export async function getRegistryStatus(registryPath = "agent-os.yml", limit = 20): Promise<string> {
  const registry = await loadRegistry(registryPath);
  const registryState = await new RegistryStateStore(registryPath).read();
  const globalConcurrency = registryState.projects.length > 0 ? registryState.globalConcurrency : registry.defaults?.maxConcurrency ?? registryState.globalConcurrency;
  const summaryByProject = new Map(registryState.projects.map((project) => [project.name, project]));
  const lines = [
    `Registry: ${resolve(registryPath)}`,
    `Global concurrency: ${globalConcurrency}`,
    `Projects: ${registry.projects.length}`
  ];

  for (const project of registry.projects) {
    const paths = resolveRegistryProjectPaths(project, registryPath);
    const summary = summaryByProject.get(project.name);
    const runtime = await new RuntimeStateStore(paths.repoRoot).read();
    const issues = await new IssueStateStore(paths.repoRoot).list();
    const logs = await new JsonlLogger(paths.repoRoot).tail(limit);
    const configLine = await projectConfigLine(paths.workflowPath).catch((error: Error) => `Config: unavailable (${error.message})`);
    const latest = summary ?? fallbackProjectSummary(project.name, paths.repoRoot, paths.workflowPath, runtime.activeRuns.length, runtime.retryQueue.length, runtime.claimedIssues.length, project.maxConcurrency ?? 1);
    lines.push(
      "",
      `- ${project.name}: ${latest.status}`,
      `  Repo: ${paths.repoRoot}`,
      `  Workflow: ${paths.workflowRelativePath}`,
      `  Concurrency: active ${runtime.activeRuns.length}/${latest.maxConcurrency}; claimed ${runtime.claimedIssues.length}; retrying ${runtime.retryQueue.length}`,
      `  ${configLine}`
    );
    if (latest.dispatched != null || latest.candidates != null) {
      lines.push(`  Last pass: dispatched ${latest.dispatched ?? 0}${latest.candidates != null ? ` of ${latest.candidates} candidate(s)` : ""}`);
    }
    if (latest.lastSuccessfulTrackerReadAt) lines.push(`  Last tracker read: ${latest.lastSuccessfulTrackerReadAt}`);
    if (latest.lastError) lines.push(`  Error: ${latest.errorCategory ?? "orchestrator"} - ${latest.lastError}`);
    if (runtime.daemon?.freshnessStatus) {
      lines.push(`  Daemon: ${runtime.daemon.freshnessStatus}${runtime.daemon.freshnessMessage ? ` - ${runtime.daemon.freshnessMessage}` : ""}`);
    }

    const issueLines = issues.map((issue) => `  - ${issue.issueIdentifier}: ${issueStatusLine(issue, runtime, logs)}`);
    lines.push(issueLines.length ? "  Issues:" : "  Issues: none recorded");
    lines.push(...issueLines);
  }

  return lines.join("\n");
}

export async function inspectIssue(repo = process.cwd(), identifier: string, limit = 30): Promise<string> {
  const root = resolve(repo);
  const statePath = join(root, ".agent-os", "state", "issues", `${safeFileName(identifier)}.json`);
  const logger = new JsonlLogger(root);
  const entries = (await logger.tail(500))
    .filter((entry) => entry.issueIdentifier?.toLowerCase() === identifier.toLowerCase())
    .slice(-limit);
  const state = (await exists(statePath)) ? normalizeIssueState(JSON.parse(await readText(statePath))) : null;
  const prs = state?.prs ?? [];
  const reviewRoot = join(root, ".agent-os", "reviews", safeFileName(identifier));
  const reviewArtifacts = (await exists(reviewRoot)) ? await listReviewArtifacts(reviewRoot) : [];
  const lines = [
    `Issue: ${identifier}`,
    state ? `Phase: ${state.phase ?? "unknown"}` : "Phase: unknown",
    state?.lifecycleStatus ? `Lifecycle: ${state.lifecycleStatus}` : null,
    state?.terminalState ? `Terminal state: ${state.terminalState}${state.terminalReason ? ` (${state.terminalReason})` : ""}` : null,
    prs.length ? `PRs:\n${prs.map((pr) => `- ${pr.url}${pr.role ? ` (${pr.role})` : ""}`).join("\n")}` : "PRs: none recorded",
    state?.reviewStatus ? `Review: ${state.reviewStatus}${state.reviewIteration ? ` iteration ${state.reviewIteration}` : ""}` : "Review: none recorded",
    state?.mergeTargetUrl ? `Merge target: ${state.mergeTargetUrl}${state.mergeTargetRole ? ` (${state.mergeTargetRole})` : ""}` : null,
    state?.mergeCleanupWarnings?.length ? `Merge cleanup warnings:\n${state.mergeCleanupWarnings.map((warning) => `- ${warning}`).join("\n")}` : null,
    validationDetails(state?.validation),
    state?.lastError ? `Last error: ${state.lastError}` : null,
    state?.stopReason ? `Stop reason: ${state.stopReason}` : null,
    state?.nextRetryAt ? `Next retry: ${state.nextRetryAt}` : null,
    reviewArtifacts.length ? `Review artifacts:\n${reviewArtifacts.map((path) => `- ${path}`).join("\n")}` : "Review artifacts: none",
    "",
    "Recent events:",
    entries.length
      ? entries.map((entry) => `${entry.timestamp} ${entry.type}${entry.message ? ` - ${entry.message}` : ""}`).join("\n")
      : "No recent events for this issue."
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

async function listReviewArtifacts(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(path);
    }
  }
  await walk(root);
  return out.sort();
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function validationDetails(validation: ValidationState | undefined): string {
  if (!validation) return "Validation: none recorded";
  const lines = [
    `Validation: ${validation.status}${validation.finalStatus ? ` (final: ${validation.finalStatus})` : ""}`,
    validation.acceptedCommands?.length ? `Accepted validation commands:\n${commandLines(validation.acceptedCommands)}` : null,
    validation.additionalPassingCommands?.length ? `Additional passing commands:\n${commandLines(validation.additionalPassingCommands)}` : null,
    validation.failedHistoricalAttempts?.length ? `Failed historical attempts:\n${commandLines(validation.failedHistoricalAttempts)}` : null,
    validation.githubCi ? `GitHub CI: ${validation.githubCi.status}${validation.githubCi.headSha ? ` (${validation.githubCi.headSha})` : ""}` : null,
    validation.errors?.length ? `Validation errors:\n${validation.errors.map((error) => `- ${error}`).join("\n")}` : null
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function commandLines(commands: ValidationCommandState[]): string {
  return commands
    .map((command) => `- ${command.name}: exitCode ${command.exitCode}, finished ${command.finishedAt}`)
    .join("\n");
}

async function projectConfigLine(workflowPath: string): Promise<string> {
  const config = resolveServiceConfig(await loadWorkflow(workflowPath));
  return `Config: trust=${config.trustMode}; lifecycle=${config.lifecycle.mode}; automation=${config.automation.profile}/${config.automation.repairPolicy}; workflowMax=${config.agent.maxConcurrentAgents}`;
}

function fallbackProjectSummary(name: string, repoRoot: string, workflowPath: string, activeRuns: number, retryQueue: number, claimedIssues: number, maxConcurrency: number): RegistryProjectSummary {
  return {
    name,
    repoRoot,
    workflowPath,
    status: "idle",
    checkedAt: new Date().toISOString(),
    activeRuns,
    retryQueue,
    claimedIssues,
    maxConcurrency
  };
}

function issueStatusLine(issue: IssueState, runtime: Awaited<ReturnType<RuntimeStateStore["read"]>>, logs: Awaited<ReturnType<JsonlLogger["tail"]>>): string {
  const runtimeActive = runtime.activeRuns.find((entry) => entry.issueId === issue.issueId || entry.identifier === issue.issueIdentifier);
  if (runtimeActive) return `running (${runtimeActive.phase ?? issue.phase ?? "active"})`;
  const retry = runtime.retryQueue.find((entry) => entry.issueId === issue.issueId || entry.identifier === issue.issueIdentifier);
  if (retry) return `retrying after ${retry.error ?? issue.lastError ?? "unknown error"}; next retry ${retry.dueAt}`;
  const mergeWaiting = [...logs].reverse().find((entry) => entry.issueIdentifier === issue.issueIdentifier && entry.type === "merge_waiting");
  if (mergeWaiting) return `waiting on CI - ${mergeWaiting.message ?? "selected PR checks are not ready"}`;
  const mergeFailed = [...logs].reverse().find((entry) => entry.issueIdentifier === issue.issueIdentifier && entry.type === "merge_failed");
  if (mergeFailed && issue.phase !== "completed") return `tracker/local disagreement or merge review needed - ${mergeFailed.message ?? "merge failed"}`;
  if (issue.reviewStatus === "pending" || issue.phase === "review") return `waiting on review (${issue.reviewStatus ?? "pending"})`;
  if (issue.reviewStatus === "human_required" || issue.phase === "human-required") return `waiting on Human Review${issue.lastError ? ` - ${issue.lastError}` : ""}`;
  if (issue.phase === "merge") return "waiting on merge";
  if (pullRequestUrls(issue).length > 0 && issue.reviewStatus === "approved" && issue.phase === "completed") return "waiting on merge";
  if (issue.nextRetryAt) return `retrying after ${issue.lastError ?? "unknown error"}; next retry ${issue.nextRetryAt}`;
  if (issue.validation) {
    const validation = validationStatusPhrase(issue.validation);
    if (validation) return validation;
  }
  if (issue.phase === "completed") return "completed locally";
  return `${issue.phase ?? "recorded"}${issue.lastError ? ` - ${issue.lastError}` : ""}`;
}

function validationStatusPhrase(validation: ValidationState): string | null {
  const failedFullSuite = validation.failedHistoricalAttempts?.find((command) => command.name === "npm run agent-check");
  const focusedPass = validation.additionalPassingCommands?.find((command) => /^npm test --/.test(command.name));
  if (failedFullSuite && focusedPass && validation.githubCi?.status === "passed") {
    return `local full-suite validation timing failure recorded separately; focused test passed; GitHub CI passed${validation.githubCi.headSha ? ` at ${validation.githubCi.headSha}` : ""}`;
  }
  if (validation.status === "failed") return `validation failed${validation.errors?.length ? ` - ${validation.errors.join("; ")}` : ""}`;
  return null;
}
