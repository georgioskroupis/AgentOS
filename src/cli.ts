#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { addProject, loadRegistry, removeProject } from "./registry.js";
import { applyHarness, assertHarnessProfile, doctorHarness, runHarnessCheck } from "./harness.js";
import { getStatus } from "./status.js";
import { LinearClient } from "./linear.js";
import { loadWorkflow, resolveServiceConfig } from "./workflow.js";
import { Orchestrator } from "./orchestrator.js";
import { verifyCodexAppServer } from "./runner/app-server.js";

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
  .action(async (repo, options) => {
    const profile = assertHarnessProfile(options.profile);
    const changes = await doctorHarness({ repo, profile });
    const missing = changes.filter((change) => change.action === "missing");
    for (const change of changes) {
      console.log(`${change.action}: ${change.path}`);
    }
    if (missing.length > 0) process.exitCode = 1;
  });

program
  .command("check")
  .argument("<repo>", "repository path to validate")
  .action(async (repo) => {
    process.exitCode = await runHarnessCheck(repo);
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

const linear = program.command("linear").description("Agent-callable Linear helpers");

linear
  .command("teams")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (options) => {
    const client = await linearClientFromWorkflow(options.workflow);
    const teams = await client.listTeams();
    for (const team of teams) console.log(`${team.key}\t${team.id}\t${team.name}`);
  });

linear
  .command("comment")
  .argument("<issue-id>", "Linear issue id")
  .argument("<body...>", "comment body")
  .option("--workflow <path>", "workflow path", "WORKFLOW.md")
  .action(async (issueId, body, options) => {
    const client = await linearClientFromWorkflow(options.workflow);
    await client.comment(issueId, body.join(" "));
    console.log(`commented: ${issueId}`);
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
    const ready = states.find((state) => ["ready", "todo", "backlog"].includes(state.name.toLowerCase()));
    const project = await client.createProject(options.project, team.id);
    for (const [index, title] of roadmapTitles.entries()) {
      await client.createIssue({
        teamId: team.id,
        title,
        description: roadmapDescription(index),
        projectId: project.id,
        stateId: index === 0 ? ready?.id : undefined
      });
      console.log(`created issue ${index + 1}: ${title}`);
    }
  });

program
  .command("codex-doctor")
  .option("--command <command>", "Codex app-server command", "npx codex app-server")
  .action(async (options) => {
    const result = await verifyCodexAppServer(options.command);
    console.log(result.ok ? "codex app-server available" : "codex app-server unavailable");
    if (!result.ok) {
      console.log(result.details);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);

async function linearClientFromWorkflow(workflowPath: string): Promise<LinearClient> {
  const workflow = await loadWorkflow(workflowPath);
  const config = resolveServiceConfig(workflow);
  return new LinearClient(config.tracker);
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

function roadmapDescription(index: number): string {
  const gate = index === 0 ? "This is the only issue that should start in Ready." : "Keep this issue out of Ready until the previous roadmap issue is complete.";
  return [
    gate,
    "",
    "Acceptance criteria:",
    "- Implement the behavior described in the AgentOS end-to-end implementation plan.",
    "- Run relevant tests and include validation evidence.",
    "- Move the issue to review with a concise handoff comment."
  ].join("\n");
}
