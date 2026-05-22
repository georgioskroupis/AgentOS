#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";

const root = process.cwd();
const failures = [];
const requiredDocs = [
  "README.md",
  "ARCHITECTURE.md",
  "WORKFLOW.md",
  "docs/README.md",
  "docs/architecture/README.md",
  "docs/architecture/AGENT_OS.md",
  "docs/decisions/README.md",
  "docs/product/README.md",
  "docs/quality/APP_LEGIBILITY.md",
  "docs/quality/PROOF_OF_WORK.md",
  "docs/quality/QUALITY_SCORE.md",
  "docs/quality/TEST_SUITE.md",
  "docs/runbooks/README.md",
  "docs/runbooks/LINEAR_SETUP.md",
  "docs/runbooks/MAINTENANCE.md",
  "docs/runbooks/ROLLOUT.md",
  "docs/runbooks/MIGRATIONS.md",
  "docs/runbooks/DOGFOODING.md",
  "docs/planning/SOURCE_ALIGNMENT_AUDIT.md",
  "docs/security/SECURITY.md",
  "docs/security/ORCHESTRATOR_TRUST_MODEL.md"
];

for (const path of requiredDocs) {
  if (!existsSync(join(root, path))) fail(`missing required doc ${path}`, "Restore the doc or remove it from the required documentation contract with a narrower replacement.");
}

checkDocsIndexCoverage();
checkMarkdownLinks();
checkCommandReferences();
checkSourceAlignmentCurrency();
checkQualityScoreRubric();
checkTestSuiteInventory();
checkMaintenanceTemplates();

if (failures.length > 0) {
  for (const failure of failures) console.error(`docs: ${failure}`);
  process.exit(1);
}

console.log("Docs check passed.");

function checkDocsIndexCoverage() {
  const index = read("docs/README.md");
  if (index == null) return;
  for (const path of requiredDocs.filter((path) => path.startsWith("docs/") && path !== "docs/README.md")) {
    if (!index.includes(path)) {
      fail(`docs/README.md does not index ${path}`, "Add the doc to the docs index so agents can discover it without searching.");
    }
  }
  const docsRoot = join(root, "docs");
  if (!existsSync(docsRoot)) return;
  for (const entry of readdirSync(docsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const readme = `docs/${entry.name}/README.md`;
    if (existsSync(join(root, readme)) && !index.includes(readme)) {
      fail(`docs/README.md does not index ${readme}`, "Link every first-level docs README from the root docs index.");
    }
  }
}

function checkMarkdownLinks() {
  for (const path of markdownFiles()) {
    const text = read(path);
    if (text == null) continue;
    for (const target of markdownLinkTargets(text)) {
      if (isExternalLink(target) || target.startsWith("#")) continue;
      const cleanTarget = target.split("#")[0].replace(/^<|>$/g, "");
      if (!cleanTarget) continue;
      const resolved = resolve(root, dirname(path), cleanTarget);
      if (!resolved.startsWith(root)) {
        fail(`${path} links outside the repository: ${target}`, "Replace escaping relative links with repo-local docs or public URLs.");
        continue;
      }
      if (!existingLinkTarget(resolved)) {
        fail(`${path} has broken link ${target}`, "Fix or remove the stale cross-link.");
      }
    }
  }
}

function checkCommandReferences() {
  const cli = read("src/cli.ts");
  const readme = read("README.md");
  if (!cli || !readme) return;
  const commands = topLevelCliCommands(cli);
  for (const command of commands) {
    if (!readme.includes(`agent-os ${command}`) && !readme.includes(`bin/agent-os ${command}`) && !readme.includes(`### \`${command}`)) {
      fail(`README.md does not mention command ${command}`, "Document every top-level CLI command in README.md or remove the command if it is not public.");
    }
  }
  for (const path of markdownFiles()) {
    const text = read(path);
    if (text == null) continue;
    for (const command of referencedAgentOsCommands(text)) {
      if (!commands.includes(command)) {
        fail(`${path} references unknown CLI command agent-os ${command}`, "Update the command reference to match src/cli.ts or add the missing command intentionally.");
      }
    }
  }
}

function checkSourceAlignmentCurrency() {
  const text = read("docs/planning/SOURCE_ALIGNMENT_AUDIT.md");
  if (text == null) return;
  for (const snippet of [
    "pre-dispatch reconciliation",
    "recoverable partial work",
    "daemon liveness",
    "Existing Implementation Audit",
    "check:architecture",
    "check:docs"
  ]) {
    if (!text.includes(snippet)) {
      fail(`docs/planning/SOURCE_ALIGNMENT_AUDIT.md missing source-alignment update for ${snippet}`, "Update the source-alignment audit when architecture, recovery, or invariant checks change.");
    }
  }
}

function checkQualityScoreRubric() {
  const text = read("docs/quality/QUALITY_SCORE.md");
  if (text == null) return;
  for (const area of [
    "Context",
    "Validation",
    "Observability",
    "Lifecycle",
    "Review loops",
    "Restart recovery",
    "Application legibility",
    "Source alignment",
    "Merge cleanup health",
    "Daemon/runtime freshness",
    "Monitor automation health",
    "PR publication/handoff completion health"
  ]) {
    if (!new RegExp(`\\|\\s*${escapeRegExp(area)}\\s*\\|`, "i").test(text)) {
      fail(`docs/quality/QUALITY_SCORE.md missing rubric area ${area}`, "Keep the quality score structurally aligned with AgentOS maintenance health categories.");
    }
  }
}

function checkTestSuiteInventory() {
  const text = read("docs/quality/TEST_SUITE.md");
  if (text == null) return;
  const testsDir = join(root, "tests");
  if (!existsSync(testsDir)) return;
  const testFiles = readdirSync(testsDir)
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => `tests/${entry}`)
    .sort();
  for (const path of testFiles) {
    if (!text.includes(`\`${path}\``)) {
      fail(`docs/quality/TEST_SUITE.md does not classify ${path}`, "Add every test file to the test-suite inventory with its layer and protected contract.");
    }
  }
  for (const heading of ["Layer Rules", "Audit Findings", "Inventory", "When To Prune"]) {
    if (!text.includes(`## ${heading}`)) {
      fail(`docs/quality/TEST_SUITE.md missing ${heading}`, "Keep the test-suite audit structured so future agents can update it mechanically.");
    }
  }
}

function checkMaintenanceTemplates() {
  const requiredTemplates = [
    "templates/maintenance/doc-gardening.md",
    "templates/maintenance/stale-runbook-detection.md",
    "templates/maintenance/quality-score-refresh.md",
    "templates/maintenance/architecture-drift-scan.md",
    "templates/maintenance/obsolete-skill-cleanup.md",
    "templates/maintenance/stale-pr-branch-report.md",
    "templates/maintenance/merged-pr-cleanup-drift-report.md",
    "templates/maintenance/stale-daemon-repo-sha-report.md",
    "templates/maintenance/stale-workspace-lock-retry-report.md",
    "templates/maintenance/automation-prompt-drift-report.md",
    "templates/maintenance/unpublished-issue-branch-failed-pr-creation-report.md"
  ];
  const contents = [];
  for (const path of requiredTemplates) {
    const text = read(path);
    if (text == null) {
      fail(`missing maintenance template ${path}`, "Restore the recurring maintenance issue template or update the maintenance seed contract.");
      continue;
    }
    contents.push(text);
  }
  contents.push(read("docs/runbooks/MAINTENANCE.md") ?? "");
  const combined = contents.join("\n").toLowerCase();
  for (const snippet of [
    "more than one active issue",
    "in progress",
    "human review",
    "merging",
    "prs merged while",
    "checks are failing",
    "root `main` is behind `origin/main`",
    "daemon",
    "stale workspace locks",
    "dirty source state",
    "committed work not pushed to origin",
    "validation, handoff, or pr body artifacts",
    "agent_pr_creation_failed",
    "hard-coded roadmap"
  ]) {
    if (!combined.includes(snippet)) {
      fail(`maintenance templates missing health-check signal: ${snippet}`, "Keep the recurring health-check templates generic and broad enough for AgentOS drift reporting.");
    }
  }
}

function topLevelCliCommands(text) {
  const commands = [
    ...[...text.matchAll(/\bprogram\s*(?:\.\s*|\n\s*\.\s*)command\("([^"]+)"/g)].map((match) => match[1]),
    ...[...text.matchAll(/\bconst\s+\w+\s*=\s*program\.command\("([^"]+)"/g)].map((match) => match[1])
  ];
  return [...new Set(commands)].sort();
}

function referencedAgentOsCommands(text) {
  const inline = [...text.matchAll(/`(?:bin\/)?agent-os\s+([a-z][a-z0-9-]*)\b[^`]*`/g)].map((match) => match[1]);
  const commandLines = [...text.matchAll(/^\s*(?:bin\/)?agent-os\s+([a-z][a-z0-9-]*)\b/gm)].map((match) => match[1]);
  return [...new Set([...inline, ...commandLines])].filter((command) => !["is", "applies"].includes(command));
}

function markdownFiles() {
  return ["README.md", "AGENTS.md", "ARCHITECTURE.md", "WORKFLOW.md", ...walk("docs").filter((path) => path.endsWith(".md")), ...walk("templates/base-harness").filter((path) => path.endsWith(".md")), ...walk("skills").filter((path) => path.endsWith(".md"))]
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .filter((path) => existsSync(join(root, path)));
}

function walk(dir) {
  const start = join(root, dir);
  if (!existsSync(start)) return [];
  const found = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile()) found.push(relative(root, child));
    }
  };
  visit(start);
  return found.sort();
}

function markdownLinkTargets(text) {
  const targets = [];
  for (const match of text.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    targets.push(match[1].trim());
  }
  return targets;
}

function isExternalLink(target) {
  return /^(?:https?:|mailto:|app:\/\/|plugin:\/\/)/i.test(target.replace(/^<|>$/g, ""));
}

function existingLinkTarget(path) {
  if (existsSync(path)) return true;
  if (!extname(path) && existsSync(`${path}.md`)) return true;
  if (existsSync(join(path, "README.md"))) return true;
  return false;
}

function read(path) {
  const fullPath = join(root, normalize(path));
  if (!existsSync(fullPath)) return null;
  if (!statSync(fullPath).isFile()) return null;
  return readFileSync(fullPath, "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message, fix) {
  failures.push(`${message}. Fix: ${fix}`);
}
