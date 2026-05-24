#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures = [];
const certificationPath = "docs/releases/agent-owned-core-certification.json";
const requiredSafetyReasons = [
  "bootstrap_failed_before_agent_start",
  "pre_dispatch_safety_block",
  "retry_budget_exhausted",
  "stale_run_recovery_required",
  "terminal_cleanup_reconciliation",
  "agent_owned_lifecycle_missing_evidence"
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

if (failures.length > 0) {
  for (const failure of failures) console.error(`certification: ${failure}`);
  process.exit(1);
}

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

function read(path) {
  const fullPath = join(root, path);
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
