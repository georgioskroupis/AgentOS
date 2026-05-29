#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  createFailureCollector,
  expectScript,
  loadProofCommands,
  proofCommandsFromArtifact,
  read,
  readJson,
  root,
  runProofCommands,
  validateProofCommands,
  validateScenarioArtifact
} from "./certification-gate-lib.mjs";

const { fail, exitIfFailures } = createFailureCollector("source-core certification");
const certificationPath = "docs/releases/source-core-certification.json";
const requiredScenarioIds = [
  "workflow-validation",
  "tracker-reader-boundary",
  "workspace-lifecycle",
  "codex-runner-fake-local-proof",
  "dispatch-retry-recovery",
  "handoff-validation",
  "agent-owned-lifecycle-evidence",
  "post-validation-noop-boundary",
  "context-budget-safety-stop",
  "validation-budget",
  "scheduler-safety-writes"
];
const excludedSourceCorePatterns = [
  /\breviewer-runner\b/,
  /\breview-retry\b/,
  /\breview-budget\b/,
  /\btests\/review\b/,
  /\bgithub\.ts\b/,
  /\bci-diagnostics\b/,
  /\bci-retry\b/,
  /\blanding-/,
  /\borchestrator-ci-retry\b/,
  /\borchestrator-merge-cleanup\b/,
  /\bdashboard\b/,
  /\bhttp-server\b/,
  /\bmonitor-aggregator\b/,
  /\bmonitor-launcher\b/,
  /\bregistry\b/,
  /\bmodel-routing\b/,
  /\blinear-graphql\b/,
  /\bclient-tools\b/,
  /\blinear-planned-issues\b/,
  /\bscope-report-scoring\b/,
  /\btracker-adapters\.test\b/
];

const traceability = spawnTraceability();
if (traceability.status !== 0) {
  fail("check:traceability failed", (traceability.stderr || traceability.stdout).trim() || "Run npm run check:traceability for details.");
}

const packageJson = readJson("package.json", fail);
const certification = readJson(certificationPath, fail);
if (packageJson) {
  expectScript(packageJson, "certification:source-core", "node scripts/certification-source-core.mjs", fail);
  expectScript(packageJson, "certification:extensions", "node scripts/certification-extensions.mjs", fail);
  expectScript(packageJson, "certification:live-e2e", "bash scripts/certification-e2e.sh", fail);
  expectScript(packageJson, "certification:agent-owned", "node scripts/certification-agent-owned.mjs", fail);
}
if (certification) {
  validateScenarioArtifact({
    artifact: certification,
    path: certificationPath,
    requiredIds: requiredScenarioIds,
    allowedClassifications: new Set(["source-core"]),
    requiredGate: "source-core",
    forbiddenEvidencePatterns: excludedSourceCorePatterns,
    fail
  });
}

for (const path of ["WORKFLOW.md", "templates/base-harness/WORKFLOW.md"]) {
  const text = read(path);
  if (!text?.includes("mode: agent-owned")) fail(`${path} is not agent-owned`, "Root and base template workflows must use agent-owned for source-faithful certification.");
  for (const tool of ["scripts/agent-linear-comment.sh", "scripts/agent-linear-move.sh", "scripts/agent-linear-pr.sh", "scripts/agent-linear-handoff.sh"]) {
    if (!text?.includes(tool)) fail(`${path} missing allowed lifecycle tool ${tool}`, "Agent-owned source-core certification requires repo-local lifecycle tools.");
  }
  if (!text?.includes("{event}") || !text.includes("{issue}") || !text.includes("{run}") || !text.includes("{attempt}")) {
    fail(`${path} missing correlated lifecycle marker format`, "Marker format must include event, issue, run, and attempt.");
  }
}

const lifecycleEvents = read("src/lifecycle-events.ts");
for (const reason of [
  "bootstrap_failed_before_agent_start",
  "pre_dispatch_safety_block",
  "retry_budget_exhausted",
  "stale_run_recovery_required",
  "terminal_cleanup_reconciliation",
  "agent_owned_lifecycle_missing_evidence"
]) {
  if (!lifecycleEvents?.includes(`"${reason}"`)) fail(`src/lifecycle-events.ts missing safety reason ${reason}`, "Scheduler safety writes must remain exhaustively enumerated.");
}

exitIfFailures();

const proofCommands = loadProofCommands(proofCommandsFromArtifact(certification), fail, "source-core");
exitIfFailures();
validateProofCommands(proofCommands, fail, {
  gateName: "source-core",
  recursivePatterns: ["certification:source-core", "certification-source-core.mjs", "certification:agent-owned", "certification-agent-owned.mjs"],
  disallowedPatterns: excludedSourceCorePatterns
});
exitIfFailures();

runProofCommands(proofCommands, fail);
exitIfFailures();

console.log("AgentOS source-core certification passed.");

function spawnTraceability() {
  return spawnSync(process.execPath, ["scripts/check-traceability.mjs"], { cwd: root, encoding: "utf8" });
}
