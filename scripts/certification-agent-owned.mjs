#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const root = process.cwd();
const failures = [];
const certificationPath = "docs/releases/agent-owned-core-certification.json";
const proofCommandOverridePath = process.env.AGENT_OS_CERTIFICATION_PROOF_COMMANDS_FILE;
const requiredSafetyReasons = [
  "bootstrap_failed_before_agent_start",
  "pre_dispatch_safety_block",
  "retry_budget_exhausted",
  "stale_run_recovery_required",
  "terminal_cleanup_reconciliation",
  "agent_owned_lifecycle_missing_evidence"
];
const curatedProofCommands = [
  {
    label: "agent-owned local scenario tests",
    command: "npm",
    args: [
      "test",
      "--",
      "tests/agent-owned-lifecycle-evidence.test.ts",
      "tests/lifecycle-controller.test.ts",
      "tests/workflow.test.ts",
      "tests/linear-graphql-tool.test.ts",
      "tests/orchestrator.test.ts",
      "tests/issue-state.test.ts",
      "tests/characterization.test.ts",
      "tests/harness.test.ts",
      "tests/app-proof-scripts.test.ts",
      "--reporter",
      "verbose"
    ],
    covers: [
      "no-PR already satisfied",
      "one-PR implementation",
      "multi-PR handoff with roles preserved",
      "missing evidence path",
      "restart recovery across lifecycle evidence steps",
      "scheduler safety reasons",
      "extension routing through lifecycle boundary checks",
      "raw GraphQL opt-in",
      "app-legibility generated harness proof"
    ]
  },
  {
    label: "agent-owned app-legibility doctor",
    command: "bin/agent-os",
    args: ["doctor", ".", "--workflow", "WORKFLOW.md"],
    covers: ["app-legibility proof enforced by doctor"]
  },
  {
    label: "architecture boundary check",
    command: "npm",
    args: ["run", "check:architecture"],
    covers: ["extension routing through lifecycle boundaries", "core scheduler architecture guardrails"]
  },
  {
    label: "docs check",
    command: "npm",
    args: ["run", "check:docs"],
    covers: ["public docs and generated harness certification consistency"]
  },
  {
    label: "traceability check",
    command: "npm",
    args: ["run", "check:traceability"],
    covers: ["machine-checkable source-faithful traceability"]
  }
];

const traceability = spawnSync(process.execPath, ["scripts/check-traceability.mjs"], { cwd: root, encoding: "utf8" });
if (traceability.status !== 0) {
  fail("check:traceability failed", (traceability.stderr || traceability.stdout).trim() || "Run npm run check:traceability for details.");
}

const packageJson = readJson("package.json");
const certification = readJson(certificationPath);
if (packageJson) {
  expectScript(packageJson, "check:traceability", "node scripts/check-traceability.mjs");
  expectScript(packageJson, "certification:agent-owned", "node scripts/certification-agent-owned.mjs");
}
if (certification) validateCertification(certification);

for (const path of ["WORKFLOW.md", "templates/base-harness/WORKFLOW.md"]) {
  const text = read(path);
  if (!text?.includes("mode: agent-owned")) fail(`${path} is not agent-owned`, "Root and base template workflows must use agent-owned for source-faithful certification.");
  for (const tool of ["scripts/agent-linear-comment.sh", "scripts/agent-linear-move.sh", "scripts/agent-linear-pr.sh", "scripts/agent-linear-handoff.sh"]) {
    if (!text?.includes(tool)) fail(`${path} missing allowed lifecycle tool ${tool}`, "Agent-owned certification requires repo-local lifecycle tools.");
  }
  if (!text?.includes("{event}") || !text.includes("{issue}") || !text.includes("{run}") || !text.includes("{attempt}")) {
    fail(`${path} missing correlated lifecycle marker format`, "Marker format must include event, issue, run, and attempt.");
  }
}

const lifecycleEvents = read("src/lifecycle-events.ts");
for (const reason of requiredSafetyReasons) {
  if (!lifecycleEvents?.includes(`"${reason}"`)) fail(`src/lifecycle-events.ts missing safety reason ${reason}`, "Scheduler safety writes must remain exhaustively enumerated.");
}

const lifecycle = read("src/lifecycle.ts");
if (!lifecycle?.includes("clientTrackerTools.includes(\"linear_graphql\")")) {
  fail("raw GraphQL opt-in predicate is missing", "linear_graphql must remain separately opted in through lifecycle.client_tracker_tools.");
}
if (!lifecycle?.includes("linear_graphql must be configured through lifecycle.client_tracker_tools")) {
  fail("raw GraphQL allowlist guard is missing", "Strict validation must reject linear_graphql in lifecycle.allowed_tracker_tools.");
}

for (const path of ["docs/quality/APP_LEGIBILITY.md", "templates/base-harness/docs/quality/APP_LEGIBILITY.md", "scripts/agent-capture-proof.sh", "templates/base-harness/scripts/agent-capture-proof.sh"]) {
  if (!existsSync(join(root, path))) fail(`${path} missing`, "Application legibility proof must be present in generated harnesses.");
}
const harness = read("src/harness.ts");
for (const snippet of ["scripts/agent-capture-proof.sh", "App-Proof:", "Proof-Artifact:"]) {
  if (!harness?.includes(snippet)) fail(`doctor contract missing ${snippet}`, "agent-os doctor must enforce app-legibility proof hooks.");
}

exitIfFailures();

const proofCommands = loadProofCommands();
validateProofCommands(proofCommands);
exitIfFailures();

for (const proofCommand of proofCommands) {
  runProofCommand(proofCommand);
}
exitIfFailures();

console.log("Agent-owned core certification passed.");

function validateCertification(certification) {
  if (certification.schemaVersion !== 1) fail(`${certificationPath} has unsupported schemaVersion`, "Use schemaVersion 1.");
  if (certification.certificationIssue !== "VER-134") fail(`${certificationPath} must certify VER-134`, "Keep the final A+ issue as the certification authority.");
  if (certification.lifecycleMode !== "agent-owned") fail(`${certificationPath} must target agent-owned`, "Agent-owned is the only source-faithful certification target.");
  if (certification.status !== "certified") fail(`${certificationPath} is not certified`, "Only pass after every local/fake-gated scenario is covered.");
  const scenarios = new Map((certification.scenarios ?? []).map((scenario) => [scenario.id, scenario]));
  for (const id of [
    "no-pr-already-satisfied",
    "one-pr-implementation",
    "multi-pr-handoff-roles-preserved",
    "missing-evidence-path",
    "restart-recovery-across-evidence-steps",
    "all-scheduler-safety-reasons",
    "extension-routing-through-lifecycle-adapters",
    "raw-graphql-opt-in-only",
    "app-legibility-proof"
  ]) {
    const scenario = scenarios.get(id);
    if (!scenario) {
      fail(`${certificationPath} missing scenario ${id}`, "Record every required agent-owned certification scenario.");
      continue;
    }
    if (scenario.status !== "covered") fail(`${certificationPath} scenario ${id} is not covered`, "Every scenario must be covered by local/fake-gated proof.");
    if (!scenario.proofCommands?.length) fail(`${certificationPath} scenario ${id} has no proof command`, "Attach executable proof commands.");
    if (!scenario.evidence?.length) fail(`${certificationPath} scenario ${id} has no evidence`, "Attach test/code/doc evidence.");
  }
  if (certification.legacyPolicy?.excludedFromCoreCertification !== true) {
    fail(`${certificationPath} does not exclude the legacy fixture from core certification`, "Legacy/test-only compatibility cannot count toward A+ source-faithful proof.");
  }
}

function expectScript(packageJson, name, command) {
  if (packageJson.scripts?.[name] !== command) fail(`package.json script ${name} is missing or changed`, `Set ${name} to ${command}.`);
}

function loadProofCommands() {
  if (!proofCommandOverridePath) return curatedProofCommands;
  const text = read(proofCommandOverridePath);
  if (text == null) {
    fail(`proof command override ${proofCommandOverridePath} missing`, "Set AGENT_OS_CERTIFICATION_PROOF_COMMANDS_FILE to a JSON array of proof commands.");
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      fail(`proof command override ${proofCommandOverridePath} is not an array`, "Use an array of { label, command, args } objects.");
      return [];
    }
    return parsed;
  } catch (error) {
    fail(`proof command override ${proofCommandOverridePath} invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "Keep proof command overrides machine-readable.");
    return [];
  }
}

function validateProofCommands(proofCommands) {
  if (!proofCommands.length) fail("certification proof command list is empty", "Run a curated local/fake proof suite, not pointer-only validation.");
  for (const [index, proofCommand] of proofCommands.entries()) {
    const label = typeof proofCommand.label === "string" && proofCommand.label.trim() ? proofCommand.label : `proof command ${index + 1}`;
    if (typeof proofCommand.command !== "string" || !proofCommand.command.trim()) {
      fail(`${label} has no command`, "Each proof command needs a non-empty command.");
    }
    if (!Array.isArray(proofCommand.args) || proofCommand.args.some((arg) => typeof arg !== "string")) {
      fail(`${label} has invalid args`, "Each proof command args field must be an array of strings.");
    }
    const commandText = [proofCommand.command, ...(Array.isArray(proofCommand.args) ? proofCommand.args : [])].join(" ");
    if (commandText.includes("certification:agent-owned") || commandText.includes("certification-agent-owned.mjs")) {
      fail(`${label} would recursively invoke agent-owned certification`, "Keep certification proof commands explicit and non-recursive.");
    }
  }
}

function runProofCommand(proofCommand) {
  const label = proofCommand.label;
  const commandLine = [proofCommand.command, ...proofCommand.args].join(" ");
  console.log(`certification proof: ${label}`);
  console.log(`  command: ${commandLine}`);
  if (Array.isArray(proofCommand.covers) && proofCommand.covers.length > 0) {
    console.log(`  covers: ${proofCommand.covers.join("; ")}`);
  }
  const result = spawnSync(proofCommand.command, proofCommand.args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    fail(
      `${label} failed`,
      [
        `Command: ${commandLine}`,
        `Exit code: ${result.status ?? "signal " + result.signal}`,
        `stdout excerpt:\n${excerpt(result.stdout)}`,
        `stderr excerpt:\n${excerpt(result.stderr)}`
      ].join("\n")
    );
    return;
  }
  console.log(`certification proof passed: ${label}`);
}

function read(path) {
  const fullPath = isAbsolute(path) ? path : join(root, path);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf8");
}

function readJson(path) {
  const text = read(path);
  if (text == null) {
    fail(`${path} missing`, "Add the required certification input.");
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${path} invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "Keep certification inputs machine-readable.");
    return null;
  }
}

function fail(message, fix) {
  failures.push(`${message}. Fix: ${fix}`);
}

function exitIfFailures() {
  if (failures.length === 0) return;
  for (const failure of failures) console.error(`certification: ${failure}`);
  process.exit(1);
}

function excerpt(text) {
  if (!text) return "<empty>";
  const normalized = text.trim();
  if (normalized.length <= 4000) return normalized;
  return `${normalized.slice(0, 1200)}\n...\n${normalized.slice(-2800)}`;
}
