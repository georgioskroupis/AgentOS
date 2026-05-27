import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const root = process.cwd();
export const proofCommandOverridePath = process.env.AGENT_OS_CERTIFICATION_PROOF_COMMANDS_FILE;

export function createFailureCollector(prefix) {
  const failures = [];
  return {
    fail(message, fix) {
      failures.push(`${message}. Fix: ${fix}`);
    },
    exitIfFailures() {
      if (failures.length === 0) return;
      for (const failure of failures) console.error(`${prefix}: ${failure}`);
      process.exit(1);
    },
    get failures() {
      return failures;
    }
  };
}

export function read(path) {
  const fullPath = isAbsolute(path) ? path : join(root, path);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, "utf8");
}

export function readJson(path, fail) {
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

export function expectScript(packageJson, name, command, fail) {
  if (packageJson.scripts?.[name] !== command) fail(`package.json script ${name} is missing or changed`, `Set ${name} to ${command}.`);
}

export function isTestContext() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

export function loadProofCommands(defaultCommands, fail, gateName) {
  if (!proofCommandOverridePath) return defaultCommands;
  // Test fixtures need tiny proof commands; real certification gates must run
  // their curated local/fake proof suites instead of env-selected shortcuts.
  if (!isTestContext()) {
    fail(
      "AGENT_OS_CERTIFICATION_PROOF_COMMANDS_FILE proof-command overrides are test-only",
      `Unset AGENT_OS_CERTIFICATION_PROOF_COMMANDS_FILE; real ${gateName} certification must execute the curated proof suite.`
    );
    return [];
  }
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

export function validateProofCommands(proofCommands, fail, options = {}) {
  const {
    gateName = "certification",
    recursivePatterns = ["certification:agent-owned", "certification-agent-owned.mjs"],
    disallowedPatterns = []
  } = options;
  if (!proofCommands.length) fail(`${gateName} proof command list is empty`, "Run a curated local/fake proof suite, not pointer-only validation.");
  for (const [index, proofCommand] of proofCommands.entries()) {
    const label = typeof proofCommand.label === "string" && proofCommand.label.trim() ? proofCommand.label : `proof command ${index + 1}`;
    if (typeof proofCommand.command !== "string" || !proofCommand.command.trim()) {
      fail(`${label} has no command`, "Each proof command needs a non-empty command.");
    }
    if (!Array.isArray(proofCommand.args) || proofCommand.args.some((arg) => typeof arg !== "string")) {
      fail(`${label} has invalid args`, "Each proof command args field must be an array of strings.");
    }
    const commandText = [proofCommand.command, ...(Array.isArray(proofCommand.args) ? proofCommand.args : [])].join(" ");
    for (const pattern of recursivePatterns) {
      if (commandText.includes(pattern)) fail(`${label} would recursively invoke ${pattern}`, "Keep certification proof commands explicit and non-recursive.");
    }
    for (const pattern of disallowedPatterns) {
      if (pattern.test(commandText)) fail(`${label} includes excluded source-core surface ${pattern}`, "Move extension or live proof to the appropriate certification gate.");
    }
  }
}

export function runProofCommands(proofCommands, fail) {
  for (const proofCommand of proofCommands) runProofCommand(proofCommand, fail);
}

export function runProofCommand(proofCommand, fail) {
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

export function validateScenarioArtifact(input) {
  const { artifact, path, requiredIds, allowedClassifications, fail, requiredGate, forbiddenEvidencePatterns = [] } = input;
  if (artifact.schemaVersion !== 1) fail(`${path} has unsupported schemaVersion`, "Use schemaVersion 1.");
  if (requiredGate && artifact.gate !== requiredGate) fail(`${path} must declare gate ${requiredGate}`, `Set gate to ${requiredGate}.`);
  if (artifact.status !== "covered" && artifact.status !== "certified") fail(`${path} is not covered`, "Only pass after every local/fake-gated scenario is covered.");
  const scenarios = new Map((artifact.scenarios ?? []).map((scenario) => [scenario.id, scenario]));
  for (const id of requiredIds) {
    const scenario = scenarios.get(id);
    if (!scenario) {
      fail(`${path} missing scenario ${id}`, "Record every required certification scenario.");
      continue;
    }
    if (scenario.status !== "covered") fail(`${path} scenario ${id} is not covered`, "Every scenario must be covered by local/fake-gated proof.");
    if (!allowedClassifications.has(scenario.classification)) fail(`${path} scenario ${id} has invalid classification`, `Use one of ${[...allowedClassifications].join(", ")}.`);
    if (!scenario.proofCommands?.length) fail(`${path} scenario ${id} has no proof command`, "Attach executable proof commands.");
    if (!scenario.evidence?.length) fail(`${path} scenario ${id} has no evidence`, "Attach test/code/doc evidence.");
    for (const command of scenario.proofCommands ?? []) {
      for (const pattern of forbiddenEvidencePatterns) {
        if (pattern.test(command)) fail(`${path} scenario ${id} proof uses excluded surface ${pattern}`, "Keep this gate focused on its declared certification boundary.");
      }
    }
    for (const evidence of scenario.evidence ?? []) {
      if (!evidence.path || !referenceExists(evidence.path)) fail(`${path} scenario ${id} references missing evidence ${evidence.path ?? "(empty)"}`, "Evidence paths must exist.");
      for (const pattern of forbiddenEvidencePatterns) {
        if (pattern.test(evidence.path) || (evidence.testName && pattern.test(evidence.testName))) {
          fail(`${path} scenario ${id} evidence uses excluded surface ${pattern}`, "Keep this gate focused on its declared certification boundary.");
        }
      }
      if (evidence.testName) {
        const text = read(evidence.path);
        if (text && !text.includes(`it("${evidence.testName}"`)) {
          fail(`${path} scenario ${id} test pointer is stale: ${evidence.path} / ${evidence.testName}`, "Point to a real Vitest case.");
        }
      }
    }
  }
}

export function proofCommandsFromArtifact(artifact) {
  const commands = new Map();
  for (const scenario of artifact.scenarios ?? []) {
    for (const commandText of scenario.proofCommands ?? []) {
      if (commands.has(commandText)) continue;
      const [command, ...args] = shellWords(commandText);
      commands.set(commandText, {
        label: `${scenario.classification} scenario: ${scenario.id}`,
        command,
        args,
        covers: [scenario.summary].filter(Boolean)
      });
    }
  }
  return [...commands.values()];
}

export function referenceExists(reference) {
  if (reference.includes("*")) {
    const pattern = new RegExp(`^${escapeRegExp(reference).replace(/\\\*/g, ".*")}$`);
    return walk(".").some((path) => pattern.test(path));
  }
  return existsSync(join(root, reference));
}

export function walk(dir) {
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

function shellWords(commandText) {
  const words = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < commandText.length; index += 1) {
    const char = commandText[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function excerpt(text) {
  if (!text) return "<empty>";
  const normalized = text.trim();
  if (normalized.length <= 4000) return normalized;
  return `${normalized.slice(0, 1200)}\n...\n${normalized.slice(-2800)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
