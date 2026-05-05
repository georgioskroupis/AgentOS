#!/usr/bin/env node
import { Command } from "commander";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_CODEX_APP_SERVER_COMMAND } from "./defaults.js";
import { addProject, loadRegistry, removeProject } from "./registry.js";
import { readText } from "./fs-utils.js";
import {
  attachPrWithAgentLifecycleTool,
  commentWithAgentLifecycleTool,
  moveWithAgentLifecycleTool,
  recordHandoffWithAgentLifecycleTool
} from "./agent-lifecycle.js";
import { applyHarness, assertHarnessProfile, doctorHarness, runHarnessCheck } from "./harness.js";
import { getStatus, inspectIssue } from "./status.js";
import { LinearClient } from "./linear.js";
import { loadWorkflow, resolveServiceConfig, validateWorkflowDefinition } from "./workflow.js";
import { Orchestrator } from "./orchestrator.js";
import { verifyGitHubCli } from "./github.js";
import { verifyCodexAppServer } from "./runner/app-server.js";
import { formatRunInspect, formatRunReplay, RunArtifactStore } from "./runs.js";
import { formatSetupReport, runSetupWizard } from "./setup-wizard.js";

const program = new Command();

program
  .name("agent-os")
  .description("Reusable harness and Symphony-style orchestration toolkit for coding agents")
  .version("0.1.0");

program
  .command("init")
  .argument("<repo>", "repository path to initialize")
  .option("--profile <profile>", "harness profile: base, typescript, python, web, api", "base")
  .option("--dry-run", "show planned changes without writing files")
  .option("--force", "overwrite existing files")
  .action(async (repo, options) => {
    const profile = assertHarnessProfile(options.profile);
    const changes = await applyHarness({
      repo,
      profile,
      dryRun: Boolean(options.dryRun),
      force: Boolean(options.force)
    });
    for (const change of changes) {
      console.log(`${change.action}: ${change.path}`);
    }
  });

program
  .command("doctor")
  .argument("<repo>", "repository path to inspect")
  .option("--profile <profile>", "harness profile to validate", "base")
  .option("--workflow <path>", "workflow path to validate", "WORKFLOW.md")
  .action(async (repo, options) => {
    const profile = assertHarnessProfile(options.profile);
    const changes = await doctorHarness({ repo, profile, workflowPath: options.workflow });
    const failing = changes.filter((change) => change.action === "missing" || change.action === "invalid");
    for (const change of changes) {
      console.log(`${change.action}: ${change.path}${change.message ? ` - ${change.message}` : ""}`);
    }
    if (failing.length > 0) process.exitCode = 1;
  });

program
  .command("setup")
  .argument("<project-path>", "project folder to initialize for AgentOS")
  .option("--dry-run", "show what setup would do without writing files or mutating Linear")
  .option("--profile <profile>", "harness profile: auto, base, typescript, python, web, api", "auto")
  .option("--greenfield", "force greenfield setup mode")
  .option("--existing", "force existing-project setup mode")
  .option("--team <team>", "Linear team id or key")
  .option("--project <project>", "Linear project name or slug")
  .option("--no-linear", "skip Linear project and workflow-state setup")
  .option("--no-codex-summary", "skip Codex project summary and use static scan only")
  .option("--no-commit", "do not offer or create the baseline commit")
  .action(async (projectPath, options) => {
    const mode = options.greenfield ? "greenfield" : options.existing ? "existing" : "auto";
    const profile = options.profile === "auto" ? "auto" : assertHarnessProfile(options.profile);
    const report = await runSetupWizard({
      projectPath,
      dryRun: Boolean(options.dryRun),
      profile,
      mode,
      team: options.team,
      project: options.project,
      linear: options.linear !== false,
      useCodexSummary: options.codexSummary !== false,
      commit: options.commit === false ? false : undefined
    });
    console.log(formatSetupReport(report));
  });

program
  .command("check")
  .argument("<repo>", "repository path to validate")
  .action(async (repo) => {
    process.exitCode = await runHarnessCheck(repo);
  });

const workflowCommand = program.command("workflow").description("Inspect and validate AgentOS workflow files");

workflowCommand
  .command("validate")
  .argument("[path]", "workflow path", "WORKFLOW.md")
  .option("--strict", "enforce production-safe workflow defaults")
  .action(async (path, options) => {
    const workflow = await loadWorkflow(path);
    const result = validateWorkflowDefinition(workflow, process.env, Boolean(options.strict));
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    for (const error of result.errors) console.error(`error: ${error}`);
    if (result.ok) {
      console.log(`Workflow OK: ${workflow.workflowPath}`);
    } else {
      process.exitCode = 1;
    }
  });

const project = program.command("project").description("Manage agent-os.yml project registry");

project
  .command("list")
  .option("--registry <path>", "registry path", "agent-os.yml")
  .action(async (options) => {
    const registry = await loadRegistry(options.registry);
    for (const item of registry.projects) {
      console.log(`${item.name}\t${item.repo}\t${item.workflow ?? "WORKFLOW.md"}`);
    }
  });

project
  .command("add")
  .argument("<name>", "project name")
  .argument("<repo>", "project repository path")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .option("--profile <profile>", "harness profile", "base")
  .option("--linear-project <slug>", "Linear project slug")
  .option("--max-concurrency <number>", "max concurrency", "1")
  .option("--registry <path>", "registry path", "agent-os.yml")
  .action(async (name, repo, options) => {
    await addProject({
      name,
      repo,
      workflow: options.workflow,
      harnessProfile: assertHarnessProfile(options.profile),
      projectSlug: options.linearProject,
      maxConcurrency: Number.parseInt(options.maxConcurrency, 10),
      registryPath: options.registry
    });
    console.log(`project added: ${name}`);
  });

project
  .command("remove")
  .argument("<name>", "project name")
  .option("--registry <path>", "registry path", "agent-os.yml")
  .action(async (name, options) => {
    await removeProject(name, options.registry);
    console.log(`project removed: ${name}`);
  });

const orchestrator = program.command("orchestrator").description("Run the Symphony-style scheduler");

orchestrator
  .command("once")
  .requiredOption("--repo <path>", "repository path")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (options) => {
    const repo = resolve(options.repo);
    const workflow = resolve(repo, options.workflow);
    const service = new Orchestrator({ repoRoot: repo, workflowPath: workflow });
    await service.runOnce(true);
  });

orchestrator
  .command("run")
  .requiredOption("--repo <path>", "repository path")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (options) => {
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    const repo = resolve(options.repo);
    const workflow = resolve(repo, options.workflow);
    const service = new Orchestrator({ repoRoot: repo, workflowPath: workflow });
    await service.runUntilStopped(controller.signal);
  });

program
  .command("status")
  .option("--repo <path>", "repository path", process.cwd())
  .option("--limit <number>", "number of recent log lines", "20")
  .action(async (options) => {
    console.log(await getStatus(options.repo, Number.parseInt(options.limit, 10)));
  });

program
  .command("inspect")
  .argument("<issue>", "Linear issue identifier, for example VER-28")
  .option("--repo <path>", "repository path", process.cwd())
  .option("--limit <number>", "number of recent issue events", "30")
  .action(async (issue, options) => {
    console.log(await inspectIssue(options.repo, issue, Number.parseInt(options.limit, 10)));
  });

const runs = program.command("runs").description("Inspect AgentOS run artifacts");

runs
  .command("inspect")
  .argument("<run-id>", "run identifier")
  .option("--repo <path>", "repository path", process.cwd())
  .action(async (runId, options) => {
    const store = new RunArtifactStore(resolve(options.repo));
    console.log(formatRunInspect(await store.inspect(runId)));
  });

runs
  .command("list")
  .option("--repo <path>", "repository path", process.cwd())
  .action(async (options) => {
    const store = new RunArtifactStore(resolve(options.repo));
    for (const run of await store.listRuns()) {
      console.log(`${run.runId}\t${run.issueIdentifier}\t${run.status}\t${run.startedAt}`);
    }
  });

runs
  .command("simulate")
  .option("--repo <path>", "repository path", process.cwd())
  .option("--issue <identifier>", "simulated issue identifier", "SIM-1")
  .option("--status <status>", "simulated result status", "succeeded")
  .action(async (options) => {
    const store = new RunArtifactStore(resolve(options.repo));
    const status = parseSimulationStatus(options.status);
    const summary = await store.simulateRun({ issueIdentifier: options.issue, status });
    console.log(`simulated run: ${summary.runId}`);
  });

runs
  .command("replay")
  .argument("<run-id>", "run identifier")
  .option("--repo <path>", "repository path", process.cwd())
  .action(async (runId, options) => {
    const store = new RunArtifactStore(resolve(options.repo));
    console.log(formatRunReplay(runId, await store.replay(runId)));
  });

const linear = program.command("linear").description("Linear helper commands");

linear
  .command("teams")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (options) => {
    const client = await linearClientFromWorkflow(options.workflow);
    const teams = await client.listTeams();
    for (const team of teams) console.log(`${team.key}\t${team.id}\t${team.name}`);
  });

linear
  .command("doctor")
  .requiredOption("--team <team>", "Linear team id or key")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (options) => {
    const workflow = await loadWorkflow(options.workflow);
    const config = resolveServiceConfig(workflow);
    const client = new LinearClient(config.tracker);
    const teams = await client.listTeams();
    const team = teams.find((candidate) => candidate.id === options.team || candidate.key === options.team);
    if (!team) throw new Error(`Linear team not found: ${options.team}`);

    const project = await client.findProject(config.tracker.projectSlug);
    if (!project) throw new Error(`Linear project not found: ${config.tracker.projectSlug}`);

    const statuses = await client.listWorkflowStates(team.id);
    const statusNames = new Set(statuses.map((status) => status.name.toLowerCase()));
    const requiredStates = [
      ...config.tracker.activeStates,
      ...config.tracker.terminalStates,
      config.tracker.runningState,
      config.tracker.reviewState,
      config.tracker.mergeState,
      config.tracker.needsInputState,
      config.github.doneState
    ].filter((state): state is string => Boolean(state));
    const missing = [...new Set(requiredStates)].filter((state) => !statusNames.has(state.toLowerCase()));
    if (missing.length > 0) {
      throw new Error(`Linear states missing in team ${team.key}: ${missing.join(", ")}`);
    }

    const candidates = await client.fetchCandidates(config.tracker.activeStates);
    const github = await verifyGitHubCli(config.github.command, process.cwd());
    console.log(`Linear OK: team=${team.key} project=${project.slugId ?? project.name}`);
    console.log(`Configured active states: ${config.tracker.activeStates.join(", ")}`);
    console.log(`Configured merge state: ${config.tracker.mergeState ?? "(none)"}`);
    console.log(`Configured done state: ${config.github.doneState}`);
    console.log(`Wiggum review: ${config.review.enabled ? `enabled (${config.review.requiredReviewers.join(", ")})` : "disabled"}`);
    console.log(`Eligible candidate issues: ${candidates.length}`);
    console.log(github.ok ? "GitHub CLI OK" : `GitHub CLI unavailable: ${github.details}`);
    if (!github.ok) process.exitCode = 1;
  });

linear
  .command("comment")
  .argument("<issue>", "Linear issue id or identifier")
  .argument("[body...]", "comment body")
  .option("--file <path>", "read comment body from a file")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (issue, body, options) => {
    const client = await linearClientFromWorkflow(options.workflow);
    const text = options.file ? await readText(resolve(options.file)) : (body ?? []).join(" ");
    if (!text.trim()) throw new Error("comment body is required; pass text or --file <path>");
    await client.comment(issue, text);
    console.log(`commented: ${issue}`);
  });

linear
  .command("move")
  .argument("<issue>", "Linear issue id or identifier")
  .argument("<state>", "target state name")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (issue, state, options) => {
    const client = await linearClientFromWorkflow(options.workflow);
    await client.move(issue, state);
    console.log(`moved: ${issue} -> ${state}`);
  });

const linearLifecycle = linear.command("lifecycle").description("Repo-local agent lifecycle tools for Linear");

linearLifecycle
  .command("comment")
  .argument("<issue>", "Linear issue id or identifier")
  .argument("[body...]", "comment body")
  .requiredOption("--event <event>", "stable idempotency event key")
  .option("--file <path>", "read comment body from a file")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .option("--repo <path>", "repository root", process.cwd())
  .option("--tool <path>", "repo-local tool path for lifecycle.allowed_tracker_tools", "agent-os linear lifecycle comment")
  .action(async (issue, body, options) => {
    const tool = lifecycleToolForAction("comment", options.tool);
    const context = await agentLifecycleContextFromOptions(options);
    const text = await bodyFromArgsOrFile(body, options.file, context.repoRoot, "comment body");
    console.log(formatAgentLifecycleResult(await commentWithAgentLifecycleTool(context, { issue, body: text, event: options.event, tool })));
  });

linearLifecycle
  .command("move")
  .argument("<issue>", "Linear issue id or identifier")
  .argument("<state>", "target state name")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .option("--repo <path>", "repository root", process.cwd())
  .option("--tool <path>", "repo-local tool path for lifecycle.allowed_tracker_tools", "agent-os linear lifecycle move")
  .action(async (issue, state, options) => {
    const tool = lifecycleToolForAction("move", options.tool);
    const context = await agentLifecycleContextFromOptions(options);
    console.log(formatAgentLifecycleResult(await moveWithAgentLifecycleTool(context, { issue, state, tool })));
  });

linearLifecycle
  .command("attach-pr")
  .argument("<issue>", "Linear issue id or identifier")
  .argument("<url>", "GitHub pull request URL")
  .option("--event <event>", "stable idempotency event key", "pr_metadata")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .option("--repo <path>", "repository root", process.cwd())
  .option("--tool <path>", "repo-local tool path for lifecycle.allowed_tracker_tools", "agent-os linear lifecycle attach-pr")
  .action(async (issue, url, options) => {
    const tool = lifecycleToolForAction("attach-pr", options.tool);
    const context = await agentLifecycleContextFromOptions(options);
    console.log(formatAgentLifecycleResult(await attachPrWithAgentLifecycleTool(context, { issue, prUrl: url, event: options.event, tool })));
  });

linearLifecycle
  .command("record-handoff")
  .argument("<issue>", "Linear issue id or identifier")
  .requiredOption("--file <path>", "handoff file to persist and post")
  .option("--event <event>", "stable idempotency event key", "run_handoff")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .option("--repo <path>", "repository root", process.cwd())
  .option("--tool <path>", "repo-local tool path for lifecycle.allowed_tracker_tools", "agent-os linear lifecycle record-handoff")
  .action(async (issue, options) => {
    const tool = lifecycleToolForAction("record-handoff", options.tool);
    const context = await agentLifecycleContextFromOptions(options);
    const handoffPath = await resolveRepoLocalInputPath(context.repoRoot, options.file, "handoff file");
    console.log(formatAgentLifecycleResult(await recordHandoffWithAgentLifecycleTool(context, { issue, handoffPath, event: options.event, tool })));
  });

linear
  .command("seed-roadmap")
  .requiredOption("--team <team>", "Linear team id or key")
  .option("--project <name>", "Linear project name", "AgentOS")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (options) => {
    const client = await linearClientFromWorkflow(options.workflow);
    const teams = await client.listTeams();
    const team = teams.find((candidate) => candidate.id === options.team || candidate.key === options.team);
    if (!team) throw new Error(`Linear team not found: ${options.team}`);
    const states = await client.listWorkflowStates(team.id);
    const startState = states.find((state) => ["todo", "ready", "backlog"].includes(state.name.toLowerCase()));
    const project = await client.createProject(options.project, team.id);
    for (const [index, title] of roadmapTitles.entries()) {
      await client.createIssue({
        teamId: team.id,
        title,
        description: roadmapDescription(index),
        projectId: project.id,
        stateId: index === 0 ? startState?.id : undefined
      });
      console.log(`created issue ${index + 1}: ${title}`);
    }
  });

linear
  .command("seed-maintenance")
  .requiredOption("--team <team>", "Linear team id or key")
  .option("--project <name>", "Linear project name", "AgentOS")
  .option("--state <name>", "Linear state for generated maintenance issues", "Backlog")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (options) => {
    const client = await linearClientFromWorkflow(options.workflow);
    const teams = await client.listTeams();
    const team = teams.find((candidate) => candidate.id === options.team || candidate.key === options.team);
    if (!team) throw new Error(`Linear team not found: ${options.team}`);
    const states = await client.listWorkflowStates(team.id);
    const state = states.find((candidate) => candidate.name.toLowerCase() === String(options.state).toLowerCase());
    if (!state) throw new Error(`Linear state not found for team ${team.key}: ${options.state}`);
    const project = (await client.findProject(options.project)) ?? (await client.createProject(options.project, team.id));
    for (const item of maintenanceIssues) {
      const issue = await client.createIssue({
        teamId: team.id,
        title: item.title,
        description: item.description,
        projectId: project.id,
        stateId: state.id
      });
      console.log(`created maintenance issue: ${issue.identifier} ${issue.title}`);
    }
  });

program
  .command("codex-doctor")
  .option("--command <command>", "Codex app-server command")
  .option("--workflow <path>", "workflow path to read Codex policy from")
  .option("--strict", "require pinned, non-latest Codex command")
  .action(async (options) => {
    let command = options.command ?? DEFAULT_CODEX_APP_SERVER_COMMAND;
    if (options.workflow) {
      const workflow = await loadWorkflow(options.workflow);
      const config = resolveServiceConfig(workflow);
      command = options.command ?? config.codex.command;
      console.log(`codex approval events: ${config.codex.approvalEventPolicy}`);
      console.log(`codex user input events: ${config.codex.userInputPolicy}`);
    }
    if (options.strict && /@latest\b/.test(command)) {
      console.log("codex app-server unavailable");
      console.log("strict mode requires a pinned Codex command");
      process.exitCode = 1;
      return;
    }
    const result = await verifyCodexAppServer(command);
    console.log(result.ok ? "codex app-server available" : "codex app-server unavailable");
    if (!result.ok) {
      console.log(result.details);
      process.exitCode = 1;
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseSimulationStatus(value: string): "succeeded" | "failed" | "timed_out" | "stalled" | "canceled" {
  if (value === "succeeded" || value === "failed" || value === "timed_out" || value === "stalled" || value === "canceled") return value;
  throw new Error(`unsupported simulation status: ${value}`);
}

async function linearClientFromWorkflow(workflowPath: string): Promise<LinearClient> {
  const workflow = await loadWorkflow(workflowPath);
  const config = resolveServiceConfig(workflow);
  return new LinearClient(config.tracker);
}

async function agentLifecycleContextFromOptions(options: { repo: string; workflow: string }): Promise<{
  repoRoot: string;
  config: ReturnType<typeof resolveServiceConfig>;
  tracker: LinearClient;
}> {
  const repoRoot = resolve(options.repo);
  const workflowPath = resolveFromRepo(repoRoot, options.workflow);
  const workflow = await loadWorkflow(workflowPath);
  const config = resolveServiceConfig(workflow);
  return { repoRoot, config, tracker: new LinearClient(config.tracker) };
}

async function bodyFromArgsOrFile(body: string[] | undefined, file: string | undefined, repoRoot: string, label: string): Promise<string> {
  const text = file ? await readText(await resolveRepoLocalInputPath(repoRoot, file, `${label} file`)) : (body ?? []).join(" ");
  if (!text.trim()) throw new Error(`${label} is required; pass text or --file <path>`);
  return text;
}

function formatAgentLifecycleResult(result: { status: string; issueIdentifier: string; marker?: string }): string {
  return [`${result.status}: ${result.issueIdentifier}`, result.marker ? `marker: ${result.marker}` : null].filter(Boolean).join("\n");
}

function resolveFromRepo(repoRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

type LifecycleCliAction = "comment" | "move" | "attach-pr" | "record-handoff";

function lifecycleToolForAction(action: LifecycleCliAction, tool: string): string {
  const lifecycleToolIdentities: Record<LifecycleCliAction, string[]> = {
    comment: ["agent-os linear lifecycle comment", "scripts/agent-linear-comment.sh"],
    move: ["agent-os linear lifecycle move", "scripts/agent-linear-move.sh"],
    "attach-pr": ["agent-os linear lifecycle attach-pr", "scripts/agent-linear-pr.sh"],
    "record-handoff": ["agent-os linear lifecycle record-handoff", "scripts/agent-linear-handoff.sh"]
  };
  const allowed = lifecycleToolIdentities[action];
  const normalizedTool = normalizeLifecycleToolIdentity(tool);
  const identity = allowed.find((candidate) => normalizeLifecycleToolIdentity(candidate) === normalizedTool);
  if (!identity) {
    throw new Error(`lifecycle tool/action mismatch: ${action} cannot use ${tool}`);
  }
  return identity;
}

function normalizeLifecycleToolIdentity(value: string): string {
  return value.trim().replace(/^\.\//, "");
}

async function resolveRepoLocalInputPath(repoRoot: string, path: string, label: string): Promise<string> {
  if (isAbsolute(path)) {
    throw new Error(`${label} must be relative to the repository root`);
  }
  const root = resolve(repoRoot);
  const resolvedPath = resolve(root, path);
  const relativePath = relative(root, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} must stay within the repository root`);
  }
  const realRoot = await realpath(root);
  const realResolvedPath = await realpath(resolvedPath);
  const realRelativePath = relative(realRoot, realResolvedPath);
  if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
    throw new Error(`${label} must stay within the repository root`);
  }
  return realResolvedPath;
}

const roadmapTitles = [
  "Connect company Linear workspace and create AgentOS project",
  "Upgrade and verify Codex App Server support",
  "Initialize AgentOS as a TypeScript CLI package with tests",
  "Expand base harness template",
  "Add reusable harness profiles",
  "Add reusable agent skills",
  "Implement init/doctor/check with profiles",
  "Implement project registry commands",
  "Implement Symphony workflow loader and config resolver",
  "Implement Linear reader adapter",
  "Implement workspace manager",
  "Implement Codex App Server runner",
  "Implement orchestrator",
  "Implement GitHub PR flow",
  "Implement observability",
  "Dogfood AgentOS on its own Linear issues",
  "Write rollout docs"
];

const maintenanceIssues = [
  {
    title: "Doc-gardening pass",
    description: [
      "Goal: scan repository docs for stale workflow, command, architecture, and product guidance.",
      "",
      "Acceptance criteria:",
      "- Compare docs against current code behavior.",
      "- Update only stale or missing source-of-truth docs.",
      "- Run `npm run agent-check`.",
      "- Handoff includes changed docs, validation, and follow-up issues."
    ].join("\n")
  },
  {
    title: "Refresh quality score",
    description: [
      "Goal: refresh `docs/quality/QUALITY_SCORE.md` against current harness capabilities.",
      "",
      "Acceptance criteria:",
      "- Review context, validation, workflow, skills, safety, and orchestration rows.",
      "- Add concrete gaps as follow-up Linear issues instead of expanding scope.",
      "- Run `npm run agent-check`."
    ].join("\n")
  },
  {
    title: "Detect workflow naming drift",
    description: [
      "Goal: find stale state names, canceled spelling variants, and duplicate workflow concepts.",
      "",
      "Acceptance criteria:",
      "- Run or improve executable drift checks.",
      "- Remove stale `Ready` wording from docs/templates if found.",
      "- Preserve `Canceled` as the only spelling.",
      "- Run `npm run agent-check`."
    ].join("\n")
  },
  {
    title: "Scan for small refactor candidates",
    description: [
      "Goal: identify duplicate helpers, stale adapters, or small code paths that harm agent legibility.",
      "",
      "Acceptance criteria:",
      "- Keep any implementation changes small and behavior-preserving.",
      "- File follow-up issues for broad refactors.",
      "- Run `npm run agent-check`."
    ].join("\n")
  }
];

function roadmapDescription(index: number): string {
  const gate = index === 0 ? "This is the only issue that should start in Todo." : "Keep this issue out of Todo until the previous roadmap issue is complete.";
  return [
    gate,
    "",
    "Acceptance criteria:",
    "- Implement the behavior described in the AgentOS end-to-end implementation plan.",
    "- Run relevant tests and include validation evidence.",
    "- Write a concise handoff; AgentOS moves the issue to review."
  ].join("\n");
}
