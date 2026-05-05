import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { DEFAULT_CODEX_APP_SERVER_COMMAND } from "./defaults.js";
import { exists, ensureDir, packageRoot, readText, writeTextEnsuringDir } from "./fs-utils.js";
import { applyHarness, doctorHarness, runHarnessCheck } from "./harness.js";
import { LinearClient, type LinearProject, type LinearState, type LinearTeam } from "./linear.js";
import { detectProjectMode, profileProject, type GreenfieldContext, type ProjectProfile, writeProjectSummary } from "./project-profiler.js";
import { verifyCodexAppServer } from "./runner/app-server.js";
import type { HarnessChange, HarnessProfile, ServiceConfig } from "./types.js";

export interface SetupWizardOptions {
  projectPath: string;
  dryRun?: boolean;
  profile?: HarnessProfile | "auto";
  mode?: "existing" | "greenfield" | "auto";
  team?: string;
  project?: string;
  linear?: boolean;
  useCodexSummary?: boolean;
  commit?: boolean;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  summaryProvider?: Parameters<typeof profileProject>[0]["summaryProvider"];
  linearClient?: LinearSetupClient;
  verify?: boolean;
}

interface LinearSetupClient {
  listTeams(): Promise<LinearTeam[]>;
  findProject(slugOrName: string): Promise<LinearProject | null>;
  createProject(name: string, teamId: string): Promise<LinearProject>;
  ensureWorkflowStates(
    teamId: string,
    required: Array<{ name: string; type: "backlog" | "unstarted" | "started" | "completed" | "canceled" }>
  ): Promise<{ states: LinearState[]; created: LinearState[]; missing: Array<{ name: string; type: string }> }>;
}

export interface SetupReport {
  repoRoot: string;
  mode: "existing" | "greenfield";
  profile: HarnessProfile;
  workflowPath: string;
  linearTeam?: LinearTeam;
  linearProject?: LinearProject;
  createdStates: LinearState[];
  harnessChanges: HarnessChange[];
  verification: Array<{ name: string; ok: boolean; details: string }>;
  summarySource: ProjectProfile["summarySource"];
  summaryError?: string;
  baselineCommit?: "created" | "skipped" | "not_git" | "no_changes" | "dry_run";
  finalCommand: string;
}

const requiredLinearStates = [
  { name: "Backlog", type: "backlog" as const },
  { name: "Todo", type: "unstarted" as const },
  { name: "In Progress", type: "started" as const },
  { name: "Human Review", type: "started" as const },
  { name: "Merging", type: "started" as const },
  { name: "Done", type: "completed" as const },
  { name: "Closed", type: "completed" as const },
  { name: "Canceled", type: "canceled" as const },
  { name: "Duplicate", type: "canceled" as const }
];

export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupReport> {
  const env = options.env ?? process.env;
  const repoRoot = resolve(options.projectPath);
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!options.dryRun) await ensureDir(repoRoot);

  const mode = await detectProjectMode(repoRoot, options.mode ?? "auto");
  const greenfield = mode === "greenfield" ? await collectGreenfieldContext(repoRoot, options, interactive) : undefined;
  let profile = await profileProject({
    repo: repoRoot,
    mode,
    profile: options.profile ?? greenfield?.preferredProfile ?? "auto",
    useCodexSummary: options.useCodexSummary ?? true,
    greenfield,
    summaryProvider: options.summaryProvider
  });
  if (profile.confidence === "low" && interactive && (!options.profile || options.profile === "auto")) {
    profile = { ...profile, recommendedProfile: await askProfile(profile.recommendedProfile) };
  }

  const linear = await setupLinear(profile, options, env, interactive);
  const workflowPath = await chooseWorkflowPath(repoRoot);
  const harnessChanges = await applyHarness({ repo: repoRoot, profile: profile.recommendedProfile, dryRun: options.dryRun });
  await tailorHarness(repoRoot, profile, workflowPath, linear.project, options.dryRun ?? false);
  await writeProjectSummary(repoRoot, profile, options.dryRun ?? false);

  const verification = options.verify === false
    ? [{ name: "verification", ok: true, details: "skipped" }]
    : await verifySetup(repoRoot, profile.recommendedProfile, workflowPath, linear.team?.key ?? options.team, options.dryRun ?? false);
  const checksPassed = verification.every((item) => item.ok);
  const baselineCommit = await maybeCreateBaselineCommit(repoRoot, checksPassed, options, interactive);
  const finalCommand = `agent-os orchestrator run --repo ${shellQuote(repoRoot)} --workflow ${shellQuote(relativeOrBase(repoRoot, workflowPath))}`;

  return {
    repoRoot,
    mode,
    profile: profile.recommendedProfile,
    workflowPath,
    linearTeam: linear.team,
    linearProject: linear.project,
    createdStates: linear.createdStates,
    harnessChanges,
    verification,
    summarySource: profile.summarySource,
    summaryError: profile.summaryError,
    baselineCommit,
    finalCommand
  };
}

export function formatSetupReport(report: SetupReport): string {
  const verification = report.verification.map((item) => `- ${item.ok ? "OK" : "FAIL"} ${item.name}${item.details ? `: ${item.details}` : ""}`).join("\n");
  return [
    "AgentOS setup complete.",
    "",
    `Project: ${report.repoRoot}`,
    `Mode: ${report.mode}`,
    `Profile: ${report.profile}`,
    `Profile summary: ${report.summarySource}${report.summaryError ? ` (${report.summaryError})` : ""}`,
    `Workflow: ${relativeOrBase(report.repoRoot, report.workflowPath)}`,
    report.linearTeam ? `Linear team: ${report.linearTeam.key} (${report.linearTeam.name})` : null,
    report.linearProject ? `Linear project: ${report.linearProject.name}${report.linearProject.slugId ? ` (${report.linearProject.slugId})` : ""}` : null,
    report.createdStates.length ? `Created Linear states: ${report.createdStates.map((state) => state.name).join(", ")}` : "Created Linear states: none",
    `Baseline commit: ${report.baselineCommit ?? "skipped"}`,
    "",
    "Verification:",
    verification,
    "",
    "Run the loop:",
    report.finalCommand,
    "",
    "Linear flow:",
    "Backlog -> Todo -> In Progress -> Human Review -> Merging -> Done"
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function collectGreenfieldContext(repoRoot: string, options: SetupWizardOptions, interactive: boolean): Promise<GreenfieldContext> {
  if (!interactive) {
    return {
      projectName: options.project ?? basenameFromPath(repoRoot),
      goal: "Greenfield project initialized with AgentOS.",
      preferredProfile: options.profile && options.profile !== "auto" ? options.profile : "base",
      constraints: ""
    };
  }
  const rl = createInterface({ input, output });
  try {
    const projectName = await question(rl, "Project name", options.project ?? basenameFromPath(repoRoot));
    const goal = await question(rl, "One-sentence goal", "Build and maintain this project with AgentOS.");
    const profile = await question(rl, "Profile (base/typescript/python/web/api)", options.profile && options.profile !== "auto" ? options.profile : "base");
    const constraints = await question(rl, "Hard constraints (optional)", "");
    return { projectName, goal, preferredProfile: normalizeProfile(profile), constraints };
  } finally {
    rl.close();
  }
}

async function setupLinear(
  profile: ProjectProfile,
  options: SetupWizardOptions,
  env: NodeJS.ProcessEnv,
  interactive: boolean
): Promise<{ team?: LinearTeam; project?: LinearProject; createdStates: LinearState[] }> {
  if (options.linear === false) return { createdStates: [] };
  if (options.dryRun) return { createdStates: [] };
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey && !options.linearClient) throw new Error("LINEAR_API_KEY is required for setup. Add it to the environment or `.agent-os/env` before running setup.");
  const client = options.linearClient ?? new LinearClient(linearTrackerConfig(apiKey ?? "", options.project ?? profile.projectName));
  const teams = await client.listTeams();
  const team = await selectTeam(teams, options.team, interactive);
  const projectName = options.project ?? (interactive ? await askText("Linear project", profile.projectName) : profile.projectName);
  const project = (await client.findProject(projectName)) ?? (await client.createProject(projectName, team.id));
  const states = await client.ensureWorkflowStates(team.id, requiredLinearStates);
  if (states.missing.length > 0) {
    throw new Error(
      [
        "Could not create required Linear workflow states. Check API/admin permissions or create them manually:",
        ...states.missing.map((state) => `- ${state.name} (${state.type})`)
      ].join("\n")
    );
  }
  return { team, project, createdStates: states.created };
}

async function chooseWorkflowPath(repoRoot: string): Promise<string> {
  const workflow = join(repoRoot, "WORKFLOW.md");
  if (!(await exists(workflow))) return workflow;
  const text = await readText(workflow);
  return isAgentOsWorkflow(text) ? workflow : join(repoRoot, "AGENTOS_WORKFLOW.md");
}

async function tailorHarness(repoRoot: string, profile: ProjectProfile, workflowPath: string, project: LinearProject | undefined, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const existingWorkflow = (await exists(workflowPath)) ? await readText(workflowPath) : null;
  const workflowText = existingWorkflow && isAgentOsWorkflow(existingWorkflow)
    ? updateWorkflowText(existingWorkflow, profile, project)
    : await renderWorkflow(profile, project);
  await writeTextEnsuringDir(workflowPath, workflowText);
  await updateMarkdownBlock(join(repoRoot, "AGENTS.md"), "AgentOS Project Context", agentContextBlock(profile));
  await updateMarkdownBlock(join(repoRoot, "ARCHITECTURE.md"), "AgentOS Architecture Notes", architectureBlock(profile));
  await updateMarkdownBlock(join(repoRoot, "docs", "product", "README.md"), "AgentOS Product Context", productBlock(profile));
  await ensureGitignore(repoRoot);
}

async function renderWorkflow(profile: ProjectProfile, project: LinearProject | undefined): Promise<string> {
  const template = await readText(join(packageRoot(), "templates", "base-harness", "WORKFLOW.md"));
  return updateWorkflowText(template, profile, project);
}

function updateWorkflowText(text: string, profile: ProjectProfile, project: LinearProject | undefined): string {
  const parsed = splitFrontMatter(text);
  const config = mergeWorkflowConfig(parsed.config, profile, project);
  const body = updateWorkflowContext(parsed.body, workflowContextBlock(profile));
  return `---\n${YAML.stringify(config).trimEnd()}\n---\n${body.trimStart()}`;
}

function mergeWorkflowConfig(config: Record<string, unknown>, profile: ProjectProfile, project: LinearProject | undefined): Record<string, unknown> {
  const tracker = objectRecord(config.tracker);
  const automation = objectRecord(config.automation);
  const lifecycle = objectRecord(config.lifecycle);
  const hooks = objectRecord(config.hooks);
  const agent = objectRecord(config.agent);
  const codex = objectRecord(config.codex);
  const github = objectRecord(config.github);
  const review = objectRecord(config.review);
  return {
    ...config,
    trust_mode: typeof config.trust_mode === "string" ? config.trust_mode : "ci-locked",
    automation: {
      ...automation,
      profile: automation.profile === "high-throughput" ? "high-throughput" : "conservative",
      repair_policy: automation.repair_policy === "mechanical-first" ? "mechanical-first" : "conservative"
    },
    lifecycle: {
      ...lifecycle,
      mode: typeof lifecycle.mode === "string" ? lifecycle.mode : "orchestrator-owned"
    },
    tracker: {
      ...tracker,
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      api_key: "$LINEAR_API_KEY",
      project_slug: project?.name ?? project?.slugId ?? profile.projectName,
      active_states: ["Todo", "In Progress"],
      terminal_states: ["Closed", "Done", "Canceled", "Duplicate"],
      running_state: "In Progress",
      review_state: "Human Review",
      merge_state: "Merging",
      needs_input_state: "Human Review"
    },
    polling: { interval_ms: 30_000, ...objectRecord(config.polling) },
    workspace: { root: ".agent-os/workspaces", ...objectRecord(config.workspace) },
    hooks: {
      ...hooks,
      after_create: 'bash "$AGENT_OS_SOURCE_REPO/scripts/agent-bootstrap-worktree.sh"',
      timeout_ms: typeof hooks.timeout_ms === "number" ? hooks.timeout_ms : 120_000
    },
    agent: {
      ...agent,
      max_concurrent_agents: typeof agent.max_concurrent_agents === "number" ? agent.max_concurrent_agents : 1,
      max_turns: typeof agent.max_turns === "number" ? agent.max_turns : 20,
      max_retry_attempts: typeof agent.max_retry_attempts === "number" ? agent.max_retry_attempts : 3,
      max_retry_backoff_ms: typeof agent.max_retry_backoff_ms === "number" ? agent.max_retry_backoff_ms : 300_000
    },
    codex: {
      ...codex,
      command: DEFAULT_CODEX_APP_SERVER_COMMAND,
      approval_event_policy: codex.approval_event_policy === "allow" ? "allow" : "deny",
      user_input_policy: codex.user_input_policy === "allow" ? "allow" : "deny",
      turn_timeout_ms: typeof codex.turn_timeout_ms === "number" ? codex.turn_timeout_ms : 3_600_000,
      read_timeout_ms: typeof codex.read_timeout_ms === "number" ? codex.read_timeout_ms : 5_000,
      stall_timeout_ms: typeof codex.stall_timeout_ms === "number" ? codex.stall_timeout_ms : 300_000
    },
    github: {
      ...github,
      command: typeof github.command === "string" ? github.command : "gh",
      merge_method: github.merge_method === "merge" || github.merge_method === "rebase" ? github.merge_method : "squash",
      merge_mode: github.merge_mode === "shepherd" || github.merge_mode === "auto" ? github.merge_mode : "manual",
      require_checks: typeof github.require_checks === "boolean" ? github.require_checks : true,
      delete_branch: typeof github.delete_branch === "boolean" ? github.delete_branch : true,
      done_state: typeof github.done_state === "string" ? github.done_state : "Done",
      allow_human_merge_override: typeof github.allow_human_merge_override === "boolean" ? github.allow_human_merge_override : false,
      merge_target: github.merge_target === "primary" ? "primary" : "primary"
    },
    review: {
      ...review,
      enabled: typeof review.enabled === "boolean" ? review.enabled : true,
      target_mode: review.target_mode === "primary" ? "primary" : "merge-eligible",
      max_iterations: typeof review.max_iterations === "number" ? review.max_iterations : 3,
      required_reviewers: stringList(review.required_reviewers, ["self", "correctness", "tests", "architecture"]),
      optional_reviewers: stringList(review.optional_reviewers, ["security"]),
      require_all_blocking_resolved: typeof review.require_all_blocking_resolved === "boolean" ? review.require_all_blocking_resolved : true,
      blocking_severities: stringList(review.blocking_severities, ["P0", "P1", "P2"])
    }
  };
}

function splitFrontMatter(text: string): { config: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) return { config: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { config: {}, body: text };
  const rawConfig = text.slice(4, end);
  const parsed = YAML.parse(rawConfig) as unknown;
  return {
    config: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {},
    body: text.slice(end + 4)
  };
}

function updateWorkflowContext(body: string, context: string): string {
  const markerStart = "<!-- AGENTOS:WORKFLOW-CONTEXT:BEGIN -->";
  const markerEnd = "<!-- AGENTOS:WORKFLOW-CONTEXT:END -->";
  const block = [markerStart, "## AgentOS Project Context", "", context.trim(), markerEnd].join("\n");
  if (body.includes(markerStart)) {
    return body.replace(new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`), block);
  }
  const heading = body.match(/^# .+$/m);
  if (!heading || heading.index === undefined) return `${block}\n\n${body.trimStart()}`;
  const insertAt = heading.index + heading[0].length;
  return `${body.slice(0, insertAt)}\n\n${block}\n${body.slice(insertAt)}`;
}

function workflowContextBlock(profile: ProjectProfile): string {
  return [
    `- Project name: ${profile.projectName}`,
    `- Detected mode: ${profile.mode}`,
    `- Recommended profile: ${profile.recommendedProfile}`,
    `- Summary source: ${profile.summarySource}${profile.summaryError ? ` (${profile.summaryError})` : ""}`,
    profile.stack.length ? `- Stack: ${profile.stack.join(", ")}` : "- Stack: not detected yet",
    profile.checkCommands.length ? `- Validation commands: ${profile.checkCommands.join(", ")}` : "- Validation commands: use `./scripts/agent-check.sh`",
    profile.architectureNotes.length ? markdownList("Architecture notes", profile.architectureNotes) : null,
    profile.missingValidation.length ? markdownList("Validation gaps", profile.missingValidation) : null,
    ""
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function markdownList(label: string, items: string[]): string {
  return [`- ${label}:`, ...items.map((item) => `  - ${item}`)].join("\n");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

async function updateMarkdownBlock(path: string, title: string, body: string): Promise<void> {
  const markerStart = "<!-- AGENTOS:BEGIN -->";
  const markerEnd = "<!-- AGENTOS:END -->";
  const block = [markerStart, `## ${title}`, "", body.trim(), markerEnd].join("\n");
  const current = (await exists(path)) ? await readText(path) : "";
  const next = current.includes(markerStart)
    ? current.replace(new RegExp(`${escapeRegExp(markerStart)}[\\s\\S]*?${escapeRegExp(markerEnd)}`), block)
    : `${current.trimEnd()}\n\n${block}\n`;
  await writeTextEnsuringDir(path, next);
}

async function ensureGitignore(repoRoot: string): Promise<void> {
  const path = join(repoRoot, ".gitignore");
  const current = (await exists(path)) ? await readText(path) : "";
  if (current.split(/\r?\n/).some((line) => line.trim() === ".agent-os/" || line.trim() === ".agent-os")) return;
  await writeTextEnsuringDir(path, `${current.trimEnd()}${current.trim() ? "\n" : ""}.agent-os/\n`);
}

async function verifySetup(repoRoot: string, profile: HarnessProfile, workflowPath: string, team: string | undefined, dryRun: boolean): Promise<SetupReport["verification"]> {
  if (dryRun) return [{ name: "dry-run", ok: true, details: "verification skipped" }];
  const verification: SetupReport["verification"] = [];
  const doctor = await doctorHarness({ repo: repoRoot, profile, workflowPath: relativeOrBase(repoRoot, workflowPath) });
  const doctorFailures = doctor.filter((change) => change.action === "missing" || change.action === "invalid");
  verification.push({ name: "agent-os doctor", ok: doctorFailures.length === 0, details: doctorFailures.map((change) => `${change.path}${change.message ? ` (${change.message})` : ""}`).join("; ") });
  const checkCode = await runHarnessCheck(repoRoot);
  verification.push({ name: "agent-os check", ok: checkCode === 0, details: checkCode === 0 ? "" : `exit ${checkCode}` });
  if (team) {
    const linear = await verifyLinearWorkflow(workflowPath, team).catch((error: Error) => ({ ok: false, details: error.message }));
    verification.push({ name: "agent-os linear doctor", ok: linear.ok, details: linear.details });
  }
  const codex = await verifyCodexAppServer();
  verification.push({ name: "agent-os codex-doctor", ok: codex.ok, details: codex.ok ? "" : codex.details.slice(0, 240) });
  return verification;
}

async function verifyLinearWorkflow(workflowPath: string, teamKeyOrId: string): Promise<{ ok: boolean; details: string }> {
  const { loadWorkflow, resolveServiceConfig } = await import("./workflow.js");
  const workflow = await loadWorkflow(workflowPath);
  const config = resolveServiceConfig(workflow);
  const client = new LinearClient(config.tracker);
  const teams = await client.listTeams();
  const team = teams.find((candidate) => candidate.id === teamKeyOrId || candidate.key === teamKeyOrId);
  if (!team) throw new Error(`Linear team not found: ${teamKeyOrId}`);
  const states = await client.listWorkflowStates(team.id);
  const names = new Set(states.map((state) => state.name.toLowerCase()));
  const missing = requiredLinearStates.filter((state) => !names.has(state.name.toLowerCase()));
  return { ok: missing.length === 0, details: missing.length ? `missing ${missing.map((state) => state.name).join(", ")}` : "" };
}

async function maybeCreateBaselineCommit(repoRoot: string, checksPassed: boolean, options: SetupWizardOptions, interactive: boolean): Promise<SetupReport["baselineCommit"]> {
  if (options.dryRun) return "dry_run";
  if (options.commit === false) return "skipped";
  if (!(await isGitRepo(repoRoot))) return "not_git";
  const changed = await capture("git", ["status", "--porcelain"], repoRoot);
  if (!changed.trim()) return "no_changes";
  if (!checksPassed) return "skipped";
  const shouldCommit = options.commit === true || (interactive && (await askYesNo("Create baseline commit `Install AgentOS harness`?", true)));
  if (!shouldCommit) return "skipped";
  await run("git", ["add", "."], repoRoot);
  await run("git", ["commit", "-m", "Install AgentOS harness"], repoRoot);
  return "created";
}

async function selectTeam(teams: LinearTeam[], requested: string | undefined, interactive: boolean): Promise<LinearTeam> {
  if (requested) {
    const found = teams.find((team) => team.id === requested || team.key === requested);
    if (!found) throw new Error(`Linear team not found: ${requested}`);
    return found;
  }
  if (teams.length === 1 || !interactive) {
    const first = teams[0];
    if (!first) throw new Error("No Linear teams were found for this API key.");
    return first;
  }
  const choices = teams.map((team, index) => `${index + 1}. ${team.key} ${team.name}`).join("\n");
  const answer = await askText(`Linear team\n${choices}\nChoose team number`, "1");
  const index = Math.max(0, Number.parseInt(answer, 10) - 1);
  const selected = teams[index];
  if (!selected) throw new Error(`Invalid Linear team selection: ${answer}`);
  return selected;
}

async function askProfile(fallback: HarnessProfile): Promise<HarnessProfile> {
  return normalizeProfile(await askText("Profile (base/typescript/python/web/api)", fallback));
}

async function askText(prompt: string, fallback: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return question(rl, prompt, fallback);
  } finally {
    rl.close();
  }
}

async function askYesNo(prompt: string, fallback: boolean): Promise<boolean> {
  const answer = (await askText(`${prompt} ${fallback ? "[Y/n]" : "[y/N]"}`, fallback ? "y" : "n")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function question(rl: ReturnType<typeof createInterface>, label: string, fallback: string): Promise<string> {
  const answer = await rl.question(`${label}${fallback ? ` (${fallback})` : ""}: `);
  return answer.trim() || fallback;
}

function linearTrackerConfig(apiKey: string, projectSlug: string): ServiceConfig["tracker"] {
  return {
    kind: "linear",
    endpoint: "https://api.linear.app/graphql",
    apiKey,
    projectSlug,
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Closed", "Done", "Canceled", "Duplicate"],
    runningState: "In Progress",
    reviewState: "Human Review",
    mergeState: "Merging",
    needsInputState: "Human Review"
  };
}

function isAgentOsWorkflow(text: string): boolean {
  return text.includes("AgentOS Workflow") || (text.includes("tracker:") && text.includes("AgentOS-Outcome") && text.includes("Ralph Wiggum"));
}

function agentContextBlock(profile: ProjectProfile): string {
  return [
    `AgentOS detected this as a \`${profile.mode}\` project using the \`${profile.recommendedProfile}\` profile.`,
    profile.stack.length ? `Detected stack: ${profile.stack.join(", ")}.` : "No framework stack was detected yet.",
    "Agents should audit existing behavior before editing, avoid duplicate implementations, and run the project harness before handoff."
  ].join("\n\n");
}

function architectureBlock(profile: ProjectProfile): string {
  return [
    profile.architectureNotes.length ? profile.architectureNotes.join("\n") : "No architecture notes were detected during setup.",
    profile.publicSurfaces.length ? `Public surfaces: ${profile.publicSurfaces.join(", ")}.` : "Public surfaces should be documented as the project grows."
  ].join("\n\n");
}

function productBlock(profile: ProjectProfile): string {
  return [
    `Project: ${profile.projectName}.`,
    profile.mode === "greenfield" ? profile.architectureNotes.join("\n") : "Product context was inferred from the existing repository. Refine this section as product decisions become clearer.",
    profile.missingValidation.length ? `Known validation gaps: ${profile.missingValidation.join(" ")}` : "Validation appears to have an initial path."
  ].join("\n\n");
}

function normalizeProfile(value: unknown): HarnessProfile {
  return value === "typescript" || value === "python" || value === "web" || value === "api" || value === "base" ? value : "base";
}

function basenameFromPath(path: string): string {
  return resolve(path).split(/[\\/]/).filter(Boolean).at(-1) ?? "project";
}

function relativeOrBase(root: string, path: string): string {
  const rel = relative(root, path).split("\\").join("/");
  return rel && !rel.startsWith("..") ? rel : path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function isGitRepo(cwd: string): Promise<boolean> {
  return run("git", ["rev-parse", "--is-inside-work-tree"], cwd).then(() => true, () => false);
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} failed with exit ${code}`))));
  });
}

function capture(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolvePromise(stdout) : reject(new Error(stderr.trim() || `${command} failed with exit ${code}`))));
  });
}
