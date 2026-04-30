import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { copyFileEnsuringDir, ensureDir, exists, makeExecutable, packageRoot, readText, rel, walkFiles } from "./fs-utils.js";
import type { HarnessChange, HarnessProfile } from "./types.js";
import { harnessProfiles } from "./types.js";

const profileTemplateDirs: Record<HarnessProfile, string[]> = {
  base: ["templates/base-harness"],
  typescript: ["templates/base-harness", "templates/profiles/typescript"],
  python: ["templates/base-harness", "templates/profiles/python"],
  web: ["templates/base-harness", "templates/profiles/web"],
  api: ["templates/base-harness", "templates/profiles/api"]
};

export function assertHarnessProfile(profile: string): HarnessProfile {
  if ((harnessProfiles as readonly string[]).includes(profile)) {
    return profile as HarnessProfile;
  }
  throw new Error(`Unknown harness profile: ${profile}`);
}

export async function applyHarness(options: {
  repo: string;
  profile: HarnessProfile;
  dryRun?: boolean;
  force?: boolean;
}): Promise<HarnessChange[]> {
  const targetRoot = resolve(options.repo);
  const root = packageRoot();
  if (!options.dryRun) await ensureDir(targetRoot);

  const changes: HarnessChange[] = [];
  for (const templateDir of profileTemplateDirs[options.profile]) {
    const sourceRoot = join(root, templateDir);
    const files = await walkFiles(sourceRoot);
    for (const source of files) {
      const relativePath = rel(sourceRoot, source);
      const target = join(targetRoot, relativePath);
      const targetExists = await exists(target);
      if (targetExists && !options.force) {
        changes.push({ action: "exists", path: relativePath, source });
        continue;
      }
      changes.push({ action: targetExists ? "overwrite" : "add", path: relativePath, source });
      if (!options.dryRun) {
        await copyFileEnsuringDir(source, target);
        if (relativePath.startsWith("scripts/") || relativePath === "bin/agent-os") {
          await makeExecutable(target);
        }
      }
    }
  }
  return changes;
}

export async function doctorHarness(options: {
  repo: string;
  profile: HarnessProfile;
  workflowPath?: string;
}): Promise<HarnessChange[]> {
  const targetRoot = resolve(options.repo);
  const root = packageRoot();
  const changes: HarnessChange[] = [];
  for (const templateDir of profileTemplateDirs[options.profile]) {
    const sourceRoot = join(root, templateDir);
    const files = await walkFiles(sourceRoot);
    for (const source of files) {
      const relativePath = rel(sourceRoot, source);
      const target = join(targetRoot, relativePath);
      const alternateTarget = alternateHarnessPath(targetRoot, relativePath);
      changes.push({
        action: (await exists(target)) || (alternateTarget ? await exists(alternateTarget) : false) ? "exists" : "missing",
        path: relativePath,
        source
      });
    }
  }
  changes.push(...(await contractChecks(targetRoot, options.workflowPath ?? "WORKFLOW.md")));
  return changes;
}

export async function runHarnessCheck(repo: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["scripts/agent-check.sh"], {
      cwd: resolve(repo),
      stdio: "inherit"
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

async function contractChecks(targetRoot: string, workflowPath = "WORKFLOW.md"): Promise<HarnessChange[]> {
  const changes: HarnessChange[] = [];
  const workflowFullPath = join(targetRoot, workflowPath);
  if (await exists(workflowFullPath)) {
    const text = await readText(workflowFullPath);
    const requiredStates = ["Todo", "In Progress", "Human Review", "Merging", "Done", "Closed", "Canceled", "Duplicate"];
    for (const state of requiredStates) {
      if (!new RegExp(`(^|[^A-Za-z])${escapeRegExp(state)}([^A-Za-z]|$)`).test(text)) {
        changes.push({ action: "invalid", path: workflowPath, message: `missing canonical workflow state: ${state}` });
      }
    }
    if (/\bReady\b/.test(text)) {
      changes.push({ action: "invalid", path: workflowPath, message: "stale `Ready` workflow wording found; use `Todo`" });
    }
    if (/\bCancelled\b|\bcancelled\b/.test(text)) {
      changes.push({ action: "invalid", path: workflowPath, message: "use `Canceled` only" });
    }
    for (const outcome of ["implemented", "partially-satisfied", "already-satisfied"]) {
      if (!text.includes(`AgentOS-Outcome: ${outcome}`)) {
        changes.push({ action: "invalid", path: workflowPath, message: `missing handoff outcome contract: AgentOS-Outcome: ${outcome}` });
      }
    }
    for (const snippet of ["review:", "max_iterations", "required_reviewers", "self", "correctness", "tests", "architecture"]) {
      if (!text.includes(snippet)) {
        changes.push({ action: "invalid", path: workflowPath, message: `missing Wiggum review contract snippet: ${snippet}` });
      }
    }
  }

  for (const path of [
    "scripts/agent-check.sh",
    "fix-bug",
    "implement-feature",
    "review-pr",
    "ci-diagnostics",
    "qa-smoke-test",
    "write-tests",
    "update-docs",
    "generate-exec-plan",
    "cleanup-tech-debt"
  ]) {
    if (path.endsWith(".sh")) {
      if (!(await exists(join(targetRoot, path)))) {
        changes.push({ action: "invalid", path, message: "required harness contract file is missing" });
      }
      continue;
    }
    const skillPaths = [join(targetRoot, "skills", path, "SKILL.md"), join(targetRoot, ".agents", "skills", path, "SKILL.md")];
    if (!(await Promise.any(skillPaths.map((candidate) => exists(candidate).then((ok) => (ok ? candidate : Promise.reject(new Error(candidate)))))).catch(() => null))) {
      changes.push({ action: "invalid", path: `.agents/skills/${path}/SKILL.md`, message: "required harness skill is missing" });
    }
  }
  return changes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternateHarnessPath(targetRoot: string, relativePath: string): string | null {
  const match = relativePath.match(/^\.agents\/skills\/([^/]+)\/SKILL\.md$/);
  return match ? join(targetRoot, "skills", match[1], "SKILL.md") : null;
}
