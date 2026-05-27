#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures = [];
const traceabilityPath = "docs/releases/CERTIFICATION_TRACEABILITY.md";
const certificationPath = "docs/releases/agent-owned-core-certification.json";
const sourceCoreCertificationPath = "docs/releases/source-core-certification.json";
const extensionCertificationPath = "docs/releases/extension-certification.json";
const allowedClassifications = new Set(["source-core", "core", "extension", "legacy", "live-e2e"]);
const requiredRefactorIssues = ["VER-128", "VER-129", "VER-130", "VER-131", "VER-132", "VER-133", "VER-134"];
const requiredScenarioIds = [
  "no-pr-already-satisfied",
  "one-pr-implementation",
  "multi-pr-handoff-roles-preserved",
  "missing-evidence-path",
  "restart-recovery-across-evidence-steps",
  "all-scheduler-safety-reasons",
  "extension-routing-through-lifecycle-adapters",
  "raw-graphql-opt-in-only",
  "app-legibility-proof"
];
const requiredSourceCoreScenarioIds = [
  "workflow-validation",
  "tracker-reader-boundary",
  "workspace-lifecycle",
  "codex-runner-fake-local-proof",
  "dispatch-retry-recovery",
  "handoff-validation",
  "agent-owned-lifecycle-evidence",
  "context-budget-safety-stop",
  "validation-budget",
  "scheduler-safety-writes"
];
const requiredExtensionScenarioIds = [
  "review-fixer-loop",
  "ci-and-merge-shepherd",
  "dashboard-monitor-extension",
  "registry-orchestration",
  "planning-dag",
  "model-routing",
  "raw-graphql-opt-in",
  "non-linear-adapter-boundary"
];

const traceability = read(traceabilityPath);
const rows = traceability ? parseTraceabilityRows(traceability) : [];
const rowIssues = new Set(rows.map((row) => row["Linear issue"]));
const classifications = new Set(rows.map((row) => row.Classification));

if (rows.length === 0) fail(`${traceabilityPath} has no traceability rows`, "Add certification rows before claiming source-faithful proof.");

for (const row of rows) validateTraceabilityRow(row);
for (const issue of requiredRefactorIssues) {
  if (!rowIssues.has(issue)) fail(`${traceabilityPath} is missing refactor issue ${issue}`, "Every A+ refactor issue must have an executable traceability row.");
}
for (const classification of allowedClassifications) {
  if (!classifications.has(classification)) fail(`${traceabilityPath} has no ${classification} row`, "Separate core, extension, legacy, and live-e2e proof explicitly.");
}

const certification = readJson(certificationPath);
if (certification) validateCertificationArtifact(certification, rowIssues);
const sourceCoreCertification = readJson(sourceCoreCertificationPath);
if (sourceCoreCertification) validateBoundaryCertificationArtifact(sourceCoreCertification, sourceCoreCertificationPath, "source-core", requiredSourceCoreScenarioIds, new Set(["source-core"]));
const extensionCertification = readJson(extensionCertificationPath);
if (extensionCertification) validateBoundaryCertificationArtifact(extensionCertification, extensionCertificationPath, "extensions", requiredExtensionScenarioIds, new Set(["extension"]));

const packageJsonText = read("package.json");
if (packageJsonText) {
  let packageJson = null;
  try {
    packageJson = JSON.parse(packageJsonText);
  } catch (error) {
    fail(`package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "Keep package metadata machine-readable.");
  }
  if (packageJson) {
    expectScript(packageJson, "certification:source-core", "node scripts/certification-source-core.mjs");
    expectScript(packageJson, "certification:extensions", "node scripts/certification-extensions.mjs");
    expectScript(packageJson, "certification:agent-owned", "node scripts/certification-agent-owned.mjs");
    expectScript(packageJson, "certification:live-e2e", "bash scripts/certification-e2e.sh");
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`traceability: ${failure}`);
  process.exit(1);
}

console.log("Traceability check passed.");

function validateTraceabilityRow(row) {
  for (const header of ["Linear issue", "PR/branch", "Classification", "Acceptance focus", "Code path", "Test or artifact", "Proof command", "Status"]) {
    if (!row[header]?.trim()) fail(`${traceabilityPath} row is missing ${header}`, "Every certification row must include all required fields.");
  }
  const issue = row["Linear issue"] ?? "";
  if (!/^VER-\d+$/.test(issue)) fail(`${traceabilityPath} has stale or malformed Linear issue reference ${issue || "(empty)"}`, "Use a current Linear issue identifier such as VER-134.");
  if (!allowedClassifications.has(row.Classification)) {
    fail(`${traceabilityPath} row ${issue} has unknown classification ${row.Classification}`, "Use one of source-core, core, extension, legacy, or live-e2e.");
  }
  if (!/^(PR #\d+|branch: [A-Za-z0-9._/-]+|release: .+|live-e2e: .+)$/.test(row["PR/branch"] ?? "")) {
    fail(`${traceabilityPath} row ${issue} has missing or invalid PR/branch`, "Use PR #N, branch: name, release: artifact, or live-e2e: gate.");
  }
  if (/\b(TBD|todo|pending proof)\b/i.test(row["Proof command"] ?? "")) {
    fail(`${traceabilityPath} row ${issue} has an unfinished proof command`, "Replace placeholder proof with an executable command.");
  }
  if (!/(npm|bin\/agent-os|scripts\/|node\s+scripts\/|bash\s+scripts\/)/.test(row["Proof command"] ?? "")) {
    fail(`${traceabilityPath} row ${issue} proof command is not executable`, "Use concrete npm, bin/agent-os, scripts, or node commands.");
  }
  for (const field of ["Code path", "Test or artifact"]) {
    for (const reference of codeReferences(row[field] ?? "")) {
      if (!referenceExists(reference)) {
        fail(`${traceabilityPath} row ${issue} references missing ${field.toLowerCase()} ${reference}`, "Point traceability at checked-in code, tests, docs, or scripts.");
      }
    }
  }
}

function validateCertificationArtifact(certification, rowIssues) {
  if (certification.schemaVersion !== 1) fail(`${certificationPath} has unsupported schemaVersion`, "Use schemaVersion 1.");
  if (certification.certificationIssue !== "VER-134") fail(`${certificationPath} must certify VER-134`, "Set certificationIssue to VER-134.");
  if (certification.status !== "certified") fail(`${certificationPath} status must be certified`, "Only mark VER-134 certified when the local fake-gated scenarios are complete.");
  if (certification.lifecycleMode !== "agent-owned") fail(`${certificationPath} must target agent-owned lifecycle`, "Agent-owned is the only source-faithful certification target.");
  if (!Array.isArray(certification.refactorIssues)) {
    fail(`${certificationPath} missing refactorIssues`, "List every A+ refactor issue with PR/branch and classification.");
  } else {
    const ids = new Set(certification.refactorIssues.map((issue) => issue.id));
    for (const id of requiredRefactorIssues) {
      if (!ids.has(id)) fail(`${certificationPath} missing refactor issue ${id}`, "Certification must link all seven A+ refactor slices.");
    }
    for (const issue of certification.refactorIssues) {
      if (!rowIssues.has(issue.id)) fail(`${certificationPath} references ${issue.id} without a traceability row`, "Add the issue to the traceability matrix.");
      if (!allowedClassifications.has(issue.classification)) fail(`${certificationPath} issue ${issue.id} has unknown classification`, "Use source-core, core, extension, legacy, or live-e2e.");
      if (!issue.prOrBranch) fail(`${certificationPath} issue ${issue.id} is missing prOrBranch`, "Record the merged PR number or current branch.");
    }
  }
  const scenarioIds = new Set((certification.scenarios ?? []).map((scenario) => scenario.id));
  for (const id of requiredScenarioIds) {
    if (!scenarioIds.has(id)) fail(`${certificationPath} missing certification scenario ${id}`, "Record every required agent-owned certification scenario.");
  }
  for (const scenario of certification.scenarios ?? []) {
    if (!requiredScenarioIds.includes(scenario.id)) fail(`${certificationPath} has unknown scenario ${scenario.id}`, "Remove undocumented certification scenarios or add them to the required contract.");
    if (scenario.status !== "covered") fail(`${certificationPath} scenario ${scenario.id} is not covered`, "Every local/fake-gated scenario must be covered before certification.");
    if (!allowedClassifications.has(scenario.classification)) fail(`${certificationPath} scenario ${scenario.id} has unknown classification`, "Use source-core, core, extension, legacy, or live-e2e.");
    if (!Array.isArray(scenario.proofCommands) || scenario.proofCommands.length === 0) fail(`${certificationPath} scenario ${scenario.id} has no proof commands`, "Attach at least one executable proof command.");
    if (!Array.isArray(scenario.evidence) || scenario.evidence.length === 0) fail(`${certificationPath} scenario ${scenario.id} has no evidence pointers`, "Attach code, test, doc, or script evidence.");
    for (const evidence of scenario.evidence ?? []) {
      if (!evidence.path || !referenceExists(evidence.path)) fail(`${certificationPath} scenario ${scenario.id} references missing evidence ${evidence.path ?? "(empty)"}`, "Evidence paths must exist.");
      if (evidence.testName) {
        const text = read(evidence.path);
        if (text && !text.includes(`it("${evidence.testName}"`)) {
          fail(`${certificationPath} scenario ${scenario.id} test pointer is stale: ${evidence.path} / ${evidence.testName}`, "Point to a real Vitest case.");
        }
      }
    }
  }
  const legacyPolicy = certification.legacyPolicy ?? {};
  if (legacyPolicy.excludedFromCoreCertification !== true || legacyPolicy.ver134BlockerUnlessRemoved !== true) {
    fail(`${certificationPath} does not exclude the test-only scheduler fallback from core certification`, "Mark any legacy fixture excluded and blocker-tracked.");
  }
}

function validateBoundaryCertificationArtifact(certification, path, gate, requiredIds, classifications) {
  if (certification.schemaVersion !== 1) fail(`${path} has unsupported schemaVersion`, "Use schemaVersion 1.");
  if (certification.certificationIssue !== "VER-139") fail(`${path} must certify VER-139`, "Boundary gate separation is certified by VER-139.");
  if (certification.gate !== gate) fail(`${path} must declare gate ${gate}`, `Set gate to ${gate}.`);
  if (certification.status !== "covered") fail(`${path} status must be covered`, "Only mark a separated gate covered when its local proof is complete.");
  const scenarioIds = new Set((certification.scenarios ?? []).map((scenario) => scenario.id));
  for (const id of requiredIds) {
    if (!scenarioIds.has(id)) fail(`${path} missing certification scenario ${id}`, "Record every required boundary certification scenario.");
  }
  for (const scenario of certification.scenarios ?? []) {
    if (!requiredIds.includes(scenario.id)) fail(`${path} has unknown scenario ${scenario.id}`, "Remove undocumented certification scenarios or add them to the required boundary contract.");
    if (scenario.status !== "covered") fail(`${path} scenario ${scenario.id} is not covered`, "Every boundary scenario must be covered before certification.");
    if (!classifications.has(scenario.classification)) fail(`${path} scenario ${scenario.id} has wrong classification`, `Use ${[...classifications].join(", ")} for this gate.`);
    if (!Array.isArray(scenario.proofCommands) || scenario.proofCommands.length === 0) fail(`${path} scenario ${scenario.id} has no proof commands`, "Attach at least one executable proof command.");
    if (!Array.isArray(scenario.evidence) || scenario.evidence.length === 0) fail(`${path} scenario ${scenario.id} has no evidence pointers`, "Attach code, test, doc, or script evidence.");
    for (const evidence of scenario.evidence ?? []) {
      if (!evidence.path || !referenceExists(evidence.path)) fail(`${path} scenario ${scenario.id} references missing evidence ${evidence.path ?? "(empty)"}`, "Evidence paths must exist.");
      if (evidence.testName) {
        const text = read(evidence.path);
        if (text && !text.includes(`it("${evidence.testName}"`)) {
          fail(`${path} scenario ${scenario.id} test pointer is stale: ${evidence.path} / ${evidence.testName}`, "Point to a real Vitest case.");
        }
      }
    }
  }
}

function expectScript(packageJson, name, command) {
  if (packageJson.scripts?.[name] !== command) fail(`package.json script ${name} is missing or changed`, `Set ${name} to ${command}.`);
}

function parseTraceabilityRows(markdown) {
  const tableLines = markdown
    .split(/\r?\n/)
    .filter((line) => /^\|.*\|$/.test(line.trim()));
  if (tableLines.length < 3) return [];
  const header = splitTableRow(tableLines[0]);
  const requiredHeaders = ["Linear issue", "PR/branch", "Classification", "Acceptance focus", "Code path", "Test or artifact", "Proof command", "Status"];
  for (const required of requiredHeaders) {
    if (!header.includes(required)) fail(`${traceabilityPath} table is missing column ${required}`, "Use the VER-134 traceability schema.");
  }
  return tableLines
    .slice(2)
    .map(splitTableRow)
    .filter((values) => values.length === header.length)
    .map((values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])));
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function codeReferences(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((value) => /^(src|tests|docs|scripts|templates|dashboard|WORKFLOW\.md|README\.md|ARCHITECTURE\.md|package\.json|bin\/agent-os)/.test(value));
}

function referenceExists(reference) {
  if (reference.includes("*")) {
    const pattern = new RegExp(`^${escapeRegExp(reference).replace(/\\\*/g, ".*")}$`);
    return walk(".").some((path) => pattern.test(path));
  }
  const fullPath = join(root, reference);
  return existsSync(fullPath);
}

function read(path) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return null;
  return readFileSync(fullPath, "utf8");
}

function readJson(path) {
  const text = read(path);
  if (text == null) {
    fail(`${path} is missing`, "Add the agent-owned certification artifact.");
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${path} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "Keep certification artifacts machine-readable.");
    return null;
  }
}

function walk(dir) {
  const start = join(root, dir);
  const found = [];
  const visit = (path) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "coverage" || entry.name === "dist") continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      if (entry.isFile()) found.push(relative(root, child));
    }
  };
  visit(start);
  return found;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message, fix) {
  failures.push(`${message}. Fix: ${fix}`);
}
