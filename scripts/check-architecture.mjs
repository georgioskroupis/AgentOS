#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const canonicalStates = ["Todo", "In Progress", "Human Review", "Merging", "Done", "Closed", "Canceled", "Duplicate"];

checkLayerBoundaries();
checkDuplicateWorkflowConcepts();
checkDuplicateStateNames("WORKFLOW.md");
checkDuplicateStateNames("templates/base-harness/WORKFLOW.md");
checkNoPrCentricRegression();
checkNoHiddenLifecyclePolicy();
checkFileBudgets();

if (failures.length > 0) {
  for (const failure of failures) console.error(`architecture: ${failure}`);
  process.exit(1);
}

console.log("Architecture check passed.");

function checkLayerBoundaries() {
  checkNoImports("src/types.ts", ["./", "../"], "Keep shared types dependency-free so every layer can import them safely.");
  checkNoImports("src/runner/app-server.ts", ["../orchestrator", "../linear", "../github", "../workspace", "../status"], "Keep the runner below orchestration and tracker/GitHub policy.");
  checkNoImports("src/fs-utils.ts", ["./orchestrator", "./linear", "./github", "./workspace"], "Keep filesystem helpers below domain and integration layers.");
  checkNoImports("src/github.ts", ["./orchestrator", "./linear"], "GitHub integration must not depend on orchestration or tracker code.");
  checkNoImports("src/linear.ts", ["./orchestrator", "./github"], "Linear integration must not depend on orchestration or GitHub code.");
  checkNoImports("src/status.ts", ["./orchestrator"], "Status reporting should read durable state instead of invoking orchestration.");
  checkCliDoesNotOwnDomainLogic();
}

function checkNoImports(path, disallowed, fix) {
  const text = read(path);
  if (text == null) return;
  for (const target of disallowed) {
    const pattern = new RegExp(`from\\s+["']${escapeRegExp(target)}`);
    if (pattern.test(text)) fail(`${path} imports disallowed boundary ${target}`, fix);
  }
}

function checkCliDoesNotOwnDomainLogic() {
  const text = read("src/cli.ts");
  if (text == null) return;
  for (const snippet of ["class Orchestrator", "class LinearClient", "class WorkspaceManager", "function evaluateMergeReadiness"]) {
    if (text.includes(snippet)) fail(`src/cli.ts owns domain logic ${snippet}`, "Move domain behavior into src/orchestrator.ts, src/linear.ts, src/workspace.ts, or another owned module, and keep the CLI as command wiring.");
  }
}

function checkDuplicateWorkflowConcepts() {
  const cli = read("src/cli.ts");
  if (cli) {
    const commands = [...cli.matchAll(/\bprogram\s*(?:\.\s*|\n\s*\.\s*)command\("([^"]+)"/g)].map((match) => match[1]);
    const duplicates = duplicateValues(commands);
    if (duplicates.length > 0) {
      fail(`duplicate workflow concept: top-level CLI command(s) ${duplicates.join(", ")}`, "Extend the existing command definition instead of adding a second top-level command.");
    }
  }

  const workflow = read("WORKFLOW.md");
  if (workflow) {
    const headings = [...workflow.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim().toLowerCase());
    const duplicates = duplicateValues(headings).filter((heading) => !["agent prompt"].includes(heading));
    if (duplicates.length > 0) {
      fail(`duplicate workflow concept: WORKFLOW.md heading(s) ${duplicates.join(", ")}`, "Merge duplicate workflow sections so agents have one source of truth.");
    }
  }
}

function checkDuplicateStateNames(path) {
  const text = read(path);
  if (text == null) return;
  const active = workflowStateList(text, "active_states");
  const terminal = workflowStateList(text, "terminal_states");
  for (const [name, values] of [
    ["active_states", active],
    ["terminal_states", terminal]
  ]) {
    const duplicates = duplicateValues(values);
    if (duplicates.length > 0) {
      fail(`${path} repeats ${name}: ${duplicates.join(", ")}`, "Remove duplicate state names; state lists must be sets so dispatch and terminal reconciliation are unambiguous.");
    }
  }
  const overlap = active.filter((state) => terminal.some((terminalState) => sameState(terminalState, state)));
  if (overlap.length > 0) {
    fail(`${path} lists state(s) as both active and terminal: ${[...new Set(overlap)].join(", ")}`, "A state cannot be both dispatchable and terminal; split the lifecycle state into exactly one list.");
  }
  for (const state of canonicalStates) {
    if (text.includes(state)) continue;
    if (path === "WORKFLOW.md" || path === "templates/base-harness/WORKFLOW.md") {
      fail(`${path} missing canonical state ${state}`, "Keep the canonical Linear lifecycle visible in workflow policy.");
    }
  }
}

function checkNoPrCentricRegression() {
  for (const path of [
    "WORKFLOW.md",
    "templates/base-harness/WORKFLOW.md",
    "README.md",
    "skills/implement-feature/SKILL.md",
    "templates/base-harness/.agents/skills/implement-feature/SKILL.md"
  ]) {
    const text = read(path);
    if (text == null) continue;
    if (/(every|all)\s+(issue|run|handoff)s?\s+(must|should|needs? to)\s+(open|create|produce)\s+(a\s+)?(pr|pull request)/i.test(text)) {
      fail(`${path} reintroduces PR-centric issue wording`, "State that issues are the unit of work and PRs are optional outputs only when the issue needs one.");
    }
    if ((path.endsWith("WORKFLOW.md") || path === "README.md") && !text.includes("Issues are the unit of work")) {
      fail(`${path} does not state that issues are the unit of work`, "Preserve issue-first wording so investigation, planning, no-op, and multi-PR outcomes remain valid.");
    }
    if ((path.endsWith("WORKFLOW.md") || path === "README.md") && !text.includes("PRs are optional outputs")) {
      fail(`${path} does not state that PRs are optional outputs`, "Preserve the no-PR and multi-PR handoff contract.");
    }
  }
}

function checkNoHiddenLifecyclePolicy() {
  const approved = new Set([
    "src/types.ts",
    "src/workflow.ts",
    "src/lifecycle.ts",
    "src/agent-lifecycle.ts",
    "src/orchestrator.ts",
    "src/orchestrator-lifecycle-comments.ts",
    "src/orchestrator-recovery-actions.ts",
    "src/orchestrator-terminal.ts",
    "src/status.ts",
    "src/status-diagnostics.ts",
    "src/issue-state.ts",
    "src/harness.ts",
    "src/setup-wizard.ts",
    "src/cli.ts"
  ]);
  const policyPattern = /\b(orchestrator-owned|agent-owned|hybrid|active_states|terminal_states|running_state|review_state|merge_state|needs_input_state|lifecycleStatus|Human Review|Merging|In Progress|Canceled|Duplicate)\b/;
  for (const path of sourceFiles("src")) {
    if (approved.has(path)) continue;
    const text = read(path);
    if (text && policyPattern.test(text)) {
      fail(`${path} contains hidden lifecycle policy wording`, "Move lifecycle state or ownership policy into workflow/lifecycle/orchestrator/status modules, or add a narrow exception with a clear owner.");
    }
  }
}

function checkFileBudgets() {
  const budgets = new Map([
    ["src/orchestrator.ts", 2800],
    ["src/cli.ts", 900],
    ["src/github.ts", 700],
    ["src/setup-wizard.ts", 700]
  ]);
  for (const path of sourceFiles("src")) {
    const text = read(path);
    if (text == null) continue;
    const limit = budgets.get(path) ?? 650;
    const lines = text.split(/\r?\n/).length;
    if (lines > limit) {
      fail(`${path} is ${lines} lines, above the ${limit}-line budget`, "Split the next coherent behavior into a named module before adding more code to this file.");
    }
  }
}

function workflowStateList(text, name) {
  const inline = text.match(new RegExp(`^\\s*${escapeRegExp(name)}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (inline) {
    return inline[1]
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const block = text.match(new RegExp(`^\\s*${escapeRegExp(name)}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"));
  if (!block) return [];
  return [...block[1].matchAll(/^\s*-\s+(.+?)\s*$/gm)].map((match) => match[1].trim().replace(/^["']|["']$/g, ""));
}

function sourceFiles(dir) {
  const start = join(root, dir);
  if (!existsSync(start)) return [];
  const found = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile() && entry.name.endsWith(".ts")) found.push(relative(root, child));
    }
  };
  visit(start);
  return found.sort();
}

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) !== index))];
}

function sameState(left, right) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function read(path) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    fail(`${path} is missing`, "Restore the expected architecture-owned file or update the check with the new source of truth.");
    return null;
  }
  if (!statSync(fullPath).isFile()) return null;
  return readFileSync(fullPath, "utf8");
}

function fail(message, fix) {
  failures.push(`${message}. Fix: ${fix}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
