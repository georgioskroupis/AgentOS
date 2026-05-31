#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const root = process.cwd();
const failures = [];
const canonicalStates = ["Todo", "In Progress", "Human Review", "Merging", "Done", "Closed", "Canceled", "Duplicate"];

checkLayerBoundaries();
checkArchitectureMapBoundaries();
checkLifecycleBoundaryContracts();
checkCoreTrackerWriteBoundaries();
checkLifecycleControllerThinBoundary();
checkMonitorContractBoundary();
checkDuplicateWorkflowConcepts();
checkDuplicateStateNames("WORKFLOW.md");
checkDuplicateStateNames("templates/base-harness/WORKFLOW.md");
checkNoPrCentricRegression();
checkNoHiddenLifecyclePolicy();
checkNoLegacyLifecycleResidue();
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

function checkArchitectureMapBoundaries() {
  const mapPath = "docs/architecture/source-module-map.json";
  const raw = read(mapPath);
  if (raw == null) return;
  let map;
  try {
    map = JSON.parse(raw);
  } catch (error) {
    fail(`${mapPath} is not valid JSON`, error instanceof Error ? error.message : "Fix the JSON syntax.");
    return;
  }

  if (!map || typeof map !== "object" || Array.isArray(map)) {
    fail(`${mapPath} must be a JSON object`, "Use an object with schemaVersion and classifications.");
    return;
  }

  const classifications = map.classifications;
  if (map.schemaVersion !== 1) fail(`${mapPath} has unsupported schemaVersion`, "Set schemaVersion to 1.");
  if (!classifications || typeof classifications !== "object" || Array.isArray(classifications)) {
    fail(`${mapPath} is missing classifications`, "Add classifications.source-core, classifications.extension-interface, and classifications.extension-implementation.");
    return;
  }

  const moduleClassifications = new Map();
  for (const [classification, paths] of Object.entries(classifications)) {
    if (!Array.isArray(paths)) {
      fail(`${mapPath} classification ${classification} is not an array`, "Store each classification as an array of repo-relative paths.");
      continue;
    }
    for (const path of paths) {
      if (typeof path !== "string" || !path.trim()) {
        fail(`${mapPath} has an invalid path in ${classification}`, "Use non-empty repo-relative path strings.");
        continue;
      }
      const normalized = normalizeRepoPath(path);
      if (!isRepoRelativePath(normalized)) {
        fail(`${mapPath} references non-repo-relative module ${path}`, "Use repo-relative module paths inside the repository.");
        continue;
      }
      if (moduleClassifications.has(normalized)) {
        fail(`${mapPath} classifies ${normalized} more than once`, "Each module must have exactly one architecture classification.");
      }
      moduleClassifications.set(normalized, classification);
      if (!existsSync(join(root, normalized))) {
        fail(`${mapPath} references missing module ${normalized}`, "Remove stale entries or restore the mapped module.");
      }
    }
  }

  for (const required of ["source-core", "extension-interface", "extension-implementation"]) {
    if (!Array.isArray(classifications[required]) || classifications[required].length === 0) {
      fail(`${mapPath} does not define ${required}`, "Keep source-core, extension-interface, and extension-implementation entries populated.");
    }
  }

  for (const sourceCorePath of classifications["source-core"] ?? []) {
    const normalizedSource = normalizeRepoPath(sourceCorePath);
    if (!isRepoRelativePath(normalizedSource)) continue;
    if (!normalizedSource.endsWith(".ts")) continue;
    const text = readOptional(normalizedSource);
    if (text == null) continue;
    for (const statement of moduleReferenceStatements(text)) {
      const target = resolveLocalModule(normalizedSource, statement.specifier);
      if (target == null) continue;
      const targetClassification = moduleClassifications.get(target);
      if (targetClassification == null) {
        fail(
          `${normalizedSource} imports unclassified module ${target}`,
          `Classify ${target} in ${mapPath} before source-core depends on it.`
        );
        continue;
      }
      if (targetClassification === "extension-implementation") {
        fail(
          `${normalizedSource} imports extension implementation ${target}`,
          "Source-core modules may import extension interfaces, but not concrete extension implementations."
        );
      }
    }
  }
}

function checkCliDoesNotOwnDomainLogic() {
  const text = read("src/cli.ts");
  if (text == null) return;
  for (const snippet of ["class Orchestrator", "class LinearClient", "class WorkspaceManager", "function evaluateMergeReadiness"]) {
    if (text.includes(snippet)) fail(`src/cli.ts owns domain logic ${snippet}`, "Move domain behavior into src/orchestrator.ts, src/linear.ts, src/workspace.ts, or another owned module, and keep the CLI as command wiring.");
  }
}

function checkLifecycleBoundaryContracts() {
  const lifecycleEvents = readOptional("src/lifecycle-events.ts");
  if (lifecycleEvents == null) {
    fail("src/lifecycle-events.ts lifecycle boundary contract file is missing", "Add src/lifecycle-events.ts before lifecycle extraction.");
  } else {
    for (const token of [
      "export const lifecycleActors",
      "export type LifecycleActor",
      "export const lifecycleEventTypes",
      "export type LifecycleEventType",
      "export const lifecycleEventSources",
      "export type LifecycleEventSource",
      "export const schedulerSafetyWriteReasons",
      "export type SchedulerSafetyWriteReason",
      "export interface LifecycleEvent",
      "export interface LifecycleController"
    ]) {
      if (!lifecycleEvents.includes(token)) {
        fail("src/lifecycle-events.ts is missing lifecycle boundary contract export", `Add ${token} so lifecycle writes have a typed event boundary before extraction.`);
      }
    }
    for (const actor of ["agent", "scheduler_safety", "extension", "supervisor"]) {
      if (!lifecycleEvents.includes(`"${actor}"`)) {
        fail("src/lifecycle-events.ts is missing a lifecycle actor", `Add lifecycle actor ${actor} to keep the event schema complete.`);
      }
    }
    for (const reason of [
      "bootstrap_failed_before_agent_start",
      "pre_dispatch_safety_block",
      "retry_budget_exhausted",
      "stale_run_recovery_required",
      "terminal_cleanup_reconciliation",
      "agent_owned_lifecycle_missing_evidence"
    ]) {
      if (!lifecycleEvents.includes(`"${reason}"`)) {
        fail("src/lifecycle-events.ts is missing a scheduler safety reason", `Add ${reason} so scheduler-owned writes remain exhaustively enumerated.`);
      }
    }
  }

  const trackerBoundaries = readOptional("src/tracker-boundaries.ts");
  if (trackerBoundaries == null) {
    fail("src/tracker-boundaries.ts tracker boundary contract file is missing", "Add src/tracker-boundaries.ts before lifecycle extraction.");
  } else {
    for (const token of [
      "export interface TrackerReader",
      "export interface TrackerLifecycleWriter",
      "export interface SchedulerSafetyWriter",
      "export interface AgentLifecycleWriter",
      "export interface TrackerCapabilities",
      "export function splitTrackerCapabilities"
    ]) {
      if (!trackerBoundaries.includes(token)) {
        fail("src/tracker-boundaries.ts is missing tracker boundary capability types", `Add ${token} so tracker reads and lifecycle writes are separated at the type boundary.`);
      }
    }
    const plannedIssueTypes = readOptional("src/linear-planned-issue-types.ts");
    for (const token of ["export interface PlanningIssueWriter", "export interface LinearAdminClient"]) {
      if (!plannedIssueTypes?.includes(token)) {
        fail("src/linear-planned-issue-types.ts is missing Linear capability type", `Add ${token} so planning/admin writes stay outside the scheduler reader boundary.`);
      }
    }
    if (!/export\s+interface\s+TrackerCapabilities\s+extends\s+TrackerReader\s*,\s*TrackerLifecycleWriter/.test(trackerBoundaries)) {
      fail("src/tracker-boundaries.ts does not compose tracker capabilities from reader/writer boundaries", "Keep TrackerCapabilities as the compatibility composition of TrackerReader and TrackerLifecycleWriter until lifecycle extraction is complete.");
    }
  }
}

function checkCoreTrackerWriteBoundaries() {
  const path = "src/orchestrator.ts";
  const text = read(path);
  if (text == null) return;

  if (/from\s+["']\.\/linear\.js["']/.test(text) || /\bnew\s+LinearClient\b/.test(text)) {
    fail(`${path} imports or constructs Linear writer integration directly`, "Core scheduler code must depend on tracker/lifecycle boundaries, not Linear writer implementation details.");
  }
  if (/\bmutation\s+[A-Za-z_][A-Za-z0-9_]*/.test(text)) {
    fail(`${path} contains a GraphQL mutation string`, "Move tracker write implementation into tracker adapters or lifecycle tools; core scheduler code must not contain raw GraphQL mutations.");
  }

  for (const match of text.matchAll(/\bthis\.tracker\.(move|comment|upsertComment)\b/g)) {
    fail(
      `${path} contains direct tracker lifecycle write ${match[0]}`,
      "Emit a lifecycle event and route through the lifecycle controller; direct tracker lifecycle writes are forbidden in core scheduler code."
    );
  }
}

function checkLifecycleControllerThinBoundary() {
  const path = "src/lifecycle-controller.ts";
  const text = readOptional(path);
  if (text == null) {
    fail(`${path} lifecycle controller implementation is missing`, "Add a thin lifecycle controller that consumes lifecycle events before removing direct tracker writes from the orchestrator.");
    return;
  }
  const disallowedImports = [
    { pattern: /(^|\/)(review|review-budget|review-budget-orchestration|reviewer-scheduler|reviewer-runner)(\.js)?$/, label: "review" },
    { pattern: /(^|\/)(ci-retry|orchestrator-ci-retry)(\.js)?$/, label: "CI repair" },
    { pattern: /(^|\/)(github|github-context|github-repository|landing-policy|landing-preflight|orchestrator-landing-preflight|orchestrator-branch-update|orchestrator-merge-cleanup|orchestrator-pr-ready)(\.js)?$/, label: "merge/landing" },
    { pattern: /(^|\/)(http-server|dashboard)(\.js)?$/, label: "dashboard" },
    { pattern: /(^|\/)(registry|registry-orchestrator)(\.js)?$/, label: "registry" },
    { pattern: /(^|\/)(model-routing)(\.js)?$/, label: "model-routing" },
    { pattern: /(^|\/)(linear|tracker-adapters)(\.js)?$/, label: "tracker adapter" },
    { pattern: /(^|\/)(orchestrator-human-decisions)(\.js)?$/, label: "human decision/review policy" }
  ];
  for (const specifier of importSpecifiers(text)) {
    for (const disallowed of disallowedImports) {
      if (disallowed.pattern.test(specifier)) {
        fail(
          `${path} imports disallowed ${disallowed.label} implementation ${specifier}`,
          "Keep lifecycle-controller thin: it may route lifecycle events to tracker capabilities, but extension policy must stay in extension-owned modules."
        );
      }
    }
  }
}

function checkMonitorContractBoundary() {
  const contractExports = [
    "MonitorSink",
    "MonitorEvent",
    "NullMonitorSink",
    "MonitorSnapshot",
    "TimingRow",
    "TimeSink",
    "HumanAction",
    "LauncherState",
    "LauncherConfig",
    "monitorSnapshotStatuses",
    "monitorUiSections"
  ];
  const extensionImplementationExports = [
    "InMemoryMonitorAggregator",
    "MonitorRunContext",
    "MonitorSnapshotOptions",
    "MonitorAggregatorRetention"
  ];
  for (const path of sourceFiles("src")) {
    if (["src/monitor-contracts.ts", "src/monitor-extension-contracts.ts", "src/index.ts"].includes(path)) continue;
    const text = read(path);
    if (text == null) continue;
    for (const token of contractExports) {
      if (new RegExp(`export\\s+(?:type|interface|class|const)\\s+${escapeRegExp(token)}\\b`).test(text)) {
        fail(`${path} duplicates monitor contract export ${token}`, "Reuse src/monitor-contracts.ts or src/monitor-extension-contracts.ts instead of redefining monitor schemas.");
      }
    }
  }

  const sourceCoreFiles = new Set([
    "src/workflow.ts",
    "src/lifecycle.ts",
    "src/lifecycle-events.ts",
    "src/lifecycle-controller.ts",
    "src/agent-lifecycle.ts",
    "src/tracker-boundaries.ts",
    "src/tracker-adapters.ts",
    "src/linear.ts",
    "src/orchestrator-tracker-guard.ts",
    "src/workspace.ts",
    "src/orchestrator-workspace-bootstrap.ts",
    "src/runner/app-server.ts",
    "src/orchestrator.ts",
    "src/runs.ts",
    "src/runtime-state.ts",
    "src/recovery.ts",
    "src/orchestrator-terminal.ts",
    "src/issue-state.ts",
    "src/orchestrator-agent-owned-evidence.ts",
    "src/agent-owned-lifecycle-evidence.ts",
    "src/validation.ts",
    "src/validation-profile.ts",
    "src/orchestrator-validation.ts",
    "src/context-budget.ts",
    "src/context-pack.ts",
    "src/monitor-contracts.ts",
    "src/monitor-sink.ts",
    "src/status.ts",
    "src/status-diagnostics.ts"
  ]);
  const allowedCoreMonitorImports = new Set(["MonitorSink", "MonitorEvent", "NullMonitorSink"]);
  const monitorSurfaceTokens = new Set([...contractExports, "MonitorStatus", "MonitorTimeClass"]);
  const monitorExtensionImplementationTokens = new Set(extensionImplementationExports);
  for (const path of sourceCoreFiles) {
    const text = readOptional(path);
    if (text == null) continue;
    for (const statement of importStatements(text)) {
      const names = importedNames(statement.clause);
      const monitorNames = names.filter((name) => monitorSurfaceTokens.has(name));
      const monitorImplementationNames = names.filter((name) => monitorExtensionImplementationTokens.has(name));
      const specifier = statement.specifier;
      if (/(^|\/)monitor-extension-contracts\.js$/.test(specifier)) {
        fail(`${path} imports extension-only monitor contracts from ${specifier}`, "Source-core may import only MonitorSink, MonitorEvent, and NullMonitorSink from src/monitor-contracts.ts.");
      }
      if (/(^|\/)monitor-aggregator\.js$/.test(specifier)) {
        fail(`${path} imports extension-only monitor aggregator from ${specifier}`, "Source-core may emit monitor events, but snapshot aggregation must stay extension-owned.");
      }
      if (/(^|\/)index\.js$/.test(specifier) && (monitorNames.length > 0 || monitorImplementationNames.length > 0)) {
        fail(`${path} imports monitor contracts or extension implementations through the src/index.ts barrel`, "Import source-core monitor contracts directly from src/monitor-contracts.ts so the barrel cannot weaken extension boundaries.");
      }
      if (/(^|\/)monitor-contracts\.js$/.test(specifier)) {
        const disallowed = monitorNames.filter((name) => !allowedCoreMonitorImports.has(name));
        if (disallowed.length > 0 || /\*\s+as\s+/.test(statement.clause)) {
          fail(`${path} imports disallowed source-core monitor surface ${disallowed.join(", ") || "namespace import"}`, "Source-core may import only named MonitorSink, MonitorEvent, and NullMonitorSink from src/monitor-contracts.ts.");
        }
      } else if (monitorImplementationNames.length > 0) {
        fail(`${path} imports extension-only monitor implementation ${monitorImplementationNames.join(", ")} from ${specifier}`, "Source-core may emit monitor events, but snapshot aggregation must stay extension-owned.");
      } else if (monitorNames.length > 0) {
        fail(`${path} imports monitor contracts from ${specifier}`, "Source-core monitor imports must come directly from src/monitor-contracts.ts.");
      }
    }
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
    "src/agent-owned-lifecycle-evidence.ts",
    "src/orchestrator-agent-owned-evidence.ts",
    "src/orchestrator.ts",
    "src/orchestrator-workspace-bootstrap.ts",
    "src/orchestrator-lifecycle-comments.ts",
    "src/merge-state-shepherd-adapter.ts",
    "src/orchestrator-planning-guardrail.ts",
    "src/orchestrator-recovery-actions.ts",
    "src/orchestrator-run-start-state-sync.ts",
    "src/orchestrator-state-drift.ts",
    "src/orchestrator-terminal.ts",
    "src/run-artifact-names.ts",
    "src/status.ts",
    "src/status-state-drift.ts",
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

function checkNoLegacyLifecycleResidue() {
  const removedSymbols = [
    "LegacyLifecycleMode",
    "applyTestOnlyLegacyLifecycleFallback",
    "usesFullOrchestratorHandoff"
  ];
  for (const path of sourceFiles("src")) {
    const text = read(path);
    if (text == null) continue;
    for (const symbol of removedSymbols) {
      if (new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(text)) {
        fail(`${path} reintroduces removed lifecycle residue ${symbol}`, "Keep production lifecycle ownership to public agent-owned behavior plus explicit scheduler-safety paths.");
      }
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
  const importBudgets = new Map([
    ["src/orchestrator.ts", 60]
  ]);
  for (const path of sourceFiles("src")) {
    const text = read(path);
    if (text == null) continue;
    const limit = budgets.get(path) ?? 650;
    const lines = text.split(/\r?\n/).length;
    if (lines > limit) {
      fail(`${path} is ${lines} lines, above the ${limit}-line budget`, "Split the next coherent behavior into a named module before adding more code to this file.");
    }
    const importLimit = importBudgets.get(path);
    if (importLimit != null) {
      const imports = importSpecifiers(text).length;
      if (imports > importLimit) {
        fail(`${path} has ${imports} import statements, above the ${importLimit}-import budget`, "Move the next coherent dependency group behind a named boundary module before adding more imports to this file.");
      }
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

function readOptional(path) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) return null;
  return readFileSync(fullPath, "utf8");
}

function importSpecifiers(text) {
  return [...text.matchAll(/^\s*import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/gm)].map((match) => match[1]);
}

function importStatements(text) {
  return [...text.matchAll(/^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm)].map((match) => ({
    clause: match[1],
    specifier: match[2]
  }));
}

function moduleReferenceStatements(text) {
  const references = [];
  for (const match of text.matchAll(/^\s*import\s+(?:type\s+)?(?:[^"']+\s+from\s+)?["']([^"']+)["']/gm)) {
    references.push({ specifier: match[1] });
  }
  for (const match of text.matchAll(/^\s*export\s+(?:type\s+)?(?:\*\s+from|[^"']+\s+from)\s+["']([^"']+)["']/gm)) {
    references.push({ specifier: match[1] });
  }
  return references;
}

function resolveLocalModule(fromPath, specifier) {
  if (!specifier.startsWith(".")) return null;
  const fromDir = dirname(fromPath);
  const withoutJs = specifier.endsWith(".js") ? specifier.slice(0, -3) : specifier;
  const candidates = [
    normalizeRepoPath(join(fromDir, `${withoutJs}.ts`)),
    normalizeRepoPath(join(fromDir, withoutJs, "index.ts"))
  ];
  return candidates.find((candidate) => existsSync(join(root, candidate))) ?? null;
}

function importedNames(clause) {
  const named = clause.match(/\{([^}]*)\}/s);
  if (!named) return [];
  return named[1]
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim())
    .filter(Boolean);
}

function fail(message, fix) {
  failures.push(`${message}. Fix: ${fix}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeRepoPath(path) {
  return normalize(path).replace(/\\/g, "/");
}

function isRepoRelativePath(path) {
  return path !== ".." && !path.startsWith("../") && !path.startsWith("/");
}
