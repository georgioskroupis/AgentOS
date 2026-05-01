#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];

checkWorkflow("WORKFLOW.md");
checkWorkflow("templates/base-harness/WORKFLOW.md");
checkSkills();
checkSetupWizard();
checkPackageDependencies();
checkCliCommands();

if (failures.length > 0) {
  for (const failure of failures) console.error(`invalid: ${failure}`);
  process.exit(1);
}

console.log("Harness contract check passed.");

function checkWorkflow(path) {
  const text = read(path);
  const states = ["Todo", "In Progress", "Human Review", "Merging", "Done", "Closed", "Canceled", "Duplicate"];
  for (const state of states) {
    if (!new RegExp(`(^|[^A-Za-z])${escapeRegExp(state)}([^A-Za-z]|$)`).test(text)) {
      failures.push(`${path} missing canonical state ${state}`);
    }
  }
  if (/\bReady\b/.test(text)) failures.push(`${path} contains stale Ready wording`);
  if (/\bCancelled\b|\bcancelled\b/.test(text)) failures.push(`${path} contains Cancelled spelling variant`);
  for (const outcome of ["implemented", "partially-satisfied", "already-satisfied"]) {
    if (!text.includes(`AgentOS-Outcome: ${outcome}`)) failures.push(`${path} missing AgentOS-Outcome: ${outcome}`);
  }
  if (!text.includes("Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json")) {
    failures.push(`${path} missing validation JSON handoff instruction`);
  }
  for (const snippet of ["scripts/agent-create-pr.sh", "--body-file", "--base", "--head", "agent_pr_creation_failed", "prs[]"]) {
    if (!text.includes(snippet)) failures.push(`${path} missing non-interactive PR creation contract ${snippet}`);
  }
  for (const snippet of ["runId", "repoHead", "git rev-parse HEAD"]) {
    if (!text.includes(snippet)) failures.push(`${path} missing validation evidence field ${snippet}`);
  }
  for (const snippet of ["review:", "max_iterations", "required_reviewers", "self", "correctness", "tests", "architecture"]) {
    if (!text.includes(snippet)) failures.push(`${path} missing Wiggum review config ${snippet}`);
  }
  for (const snippet of ["trust_mode:", "merge_mode:", "approval_event_policy: deny", "user_input_policy: deny", "allow_human_merge_override: false", "@openai/codex@0.125.0 app-server"]) {
    if (!text.includes(snippet)) failures.push(`${path} missing hardened workflow config ${snippet}`);
  }
  if (/@openai\/codex@latest\b/.test(text)) failures.push(`${path} contains unpinned Codex command`);
  for (const block of ["active_states", "terminal_states"]) {
    const configuredStates = stateBlock(text, block);
    const duplicates = configuredStates.filter((state, index) => configuredStates.indexOf(state) !== index);
    if (duplicates.length > 0) failures.push(`${path} repeats ${block}: ${[...new Set(duplicates)].join(", ")}`);
  }
}

function checkPackageDependencies() {
  const pkg = JSON.parse(read("package.json"));
  const approved = new Set(["commander", "liquidjs", "yaml"]);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!approved.has(dep)) failures.push(`package.json has unapproved production dependency ${dep}`);
  }
}

function checkCliCommands() {
  const cli = read("src/cli.ts");
  const commands = [...cli.matchAll(/program\s*\n\s*\.command\("([^"]+)"/g)].map((match) => match[1]);
  const duplicates = commands.filter((command, index) => commands.indexOf(command) !== index);
  if (duplicates.length > 0) failures.push(`src/cli.ts repeats top-level commands: ${[...new Set(duplicates)].join(", ")}`);
}

function checkSetupWizard() {
  for (const path of ["src/project-profiler.ts", "src/setup-wizard.ts"]) {
    try {
      read(path);
    } catch {
      failures.push(`${path} missing setup wizard implementation`);
    }
  }
  const cli = read("src/cli.ts");
  if (!cli.includes('.command("setup")')) failures.push("src/cli.ts missing setup command");
  if (!cli.includes("--no-linear")) failures.push("setup command missing --no-linear option");
  if (!cli.includes("--no-codex-summary")) failures.push("setup command missing --no-codex-summary option");
}

function checkSkills() {
  const required = [
    "implement-feature",
    "fix-bug",
    "review-pr",
    "write-tests",
    "update-docs",
    "generate-exec-plan",
    "cleanup-tech-debt",
    "ci-diagnostics",
    "qa-smoke-test"
  ];
  for (const skill of required) {
    for (const base of ["skills", "templates/base-harness/.agents/skills"]) {
      const path = `${base}/${skill}/SKILL.md`;
      let text = "";
      try {
        text = read(path);
      } catch {
        failures.push(`${path} missing required agent skill`);
        continue;
      }
      if (!text.startsWith("---\n")) failures.push(`${path} missing skill front matter`);
    }
  }

  for (const path of ["skills/implement-feature/SKILL.md", "templates/base-harness/.agents/skills/implement-feature/SKILL.md"]) {
    const text = read(path);
    if (!text.includes("AgentOS-Outcome: already-satisfied")) failures.push(`${path} missing no-op outcome instruction`);
    if (!text.includes("partially satisfied") && !text.includes("partially-satisfied")) failures.push(`${path} missing partial implementation guardrail`);
    if (!text.includes("scripts/agent-create-pr.sh") || !text.includes("agent_pr_creation_failed")) {
      failures.push(`${path} missing deterministic PR creation guidance`);
    }
  }

  for (const path of ["skills/review-pr/SKILL.md", "templates/base-harness/.agents/skills/review-pr/SKILL.md"]) {
    const text = read(path);
    if (!text.includes("Wiggum artifact")) failures.push(`${path} missing Wiggum artifact instruction`);
    if (!text.includes("P0") || !text.includes("P1") || !text.includes("P2")) failures.push(`${path} missing blocking severity vocabulary`);
  }

  for (const path of ["skills/ci-diagnostics/SKILL.md", "templates/base-harness/.agents/skills/ci-diagnostics/SKILL.md"]) {
    const text = read(path);
    if (!text.includes("gh pr view") || !text.includes("gh run")) failures.push(`${path} missing gh-based CI diagnostics guidance`);
  }

  for (const path of ["skills/qa-smoke-test/SKILL.md", "templates/base-harness/.agents/skills/qa-smoke-test/SKILL.md"]) {
    const text = read(path);
    if (!text.includes("agent-smoke-test.sh") || !text.includes("agent-capture-logs.sh")) failures.push(`${path} missing smoke/log validation guidance`);
  }
}

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function stateBlock(text, name) {
  const match = text.match(new RegExp(`^  ${name}:\\n((?:    - .+\\n)+)`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/^\s*-\s+(.+)\s*$/gm)].map((item) => item[1]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
