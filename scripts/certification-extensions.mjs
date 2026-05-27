#!/usr/bin/env node
import {
  createFailureCollector,
  expectScript,
  loadProofCommands,
  proofCommandsFromArtifact,
  readJson,
  runProofCommands,
  validateProofCommands,
  validateScenarioArtifact
} from "./certification-gate-lib.mjs";

const { fail, exitIfFailures } = createFailureCollector("extension certification");
const certificationPath = "docs/releases/extension-certification.json";
const requiredScenarioIds = [
  "review-fixer-loop",
  "ci-and-merge-shepherd",
  "dashboard-monitor-extension",
  "registry-orchestration",
  "planning-dag",
  "model-routing",
  "raw-graphql-opt-in",
  "non-linear-adapter-boundary"
];

const packageJson = readJson("package.json", fail);
const certification = readJson(certificationPath, fail);
if (packageJson) {
  expectScript(packageJson, "certification:extensions", "node scripts/certification-extensions.mjs", fail);
  expectScript(packageJson, "certification:source-core", "node scripts/certification-source-core.mjs", fail);
  expectScript(packageJson, "certification:agent-owned", "node scripts/certification-agent-owned.mjs", fail);
}
if (certification) {
  validateScenarioArtifact({
    artifact: certification,
    path: certificationPath,
    requiredIds: requiredScenarioIds,
    allowedClassifications: new Set(["extension"]),
    requiredGate: "extensions",
    fail
  });
}

exitIfFailures();

const proofCommands = loadProofCommands(proofCommandsFromArtifact(certification), fail, "extensions");
exitIfFailures();
validateProofCommands(proofCommands, fail, {
  gateName: "extensions",
  recursivePatterns: ["certification:extensions", "certification-extensions.mjs", "certification:agent-owned", "certification-agent-owned.mjs"]
});
exitIfFailures();

runProofCommands(proofCommands, fail);
exitIfFailures();

console.log("AgentOS extension certification passed.");
