import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { exists, isDirectory, readText, walkFiles, writeTextEnsuringDir } from "./fs-utils.js";
import type { HarnessProfile } from "./types.js";

export interface ProjectProfile {
  repoRoot: string;
  mode: "existing" | "greenfield";
  projectName: string;
  recommendedProfile: HarnessProfile;
  confidence: "high" | "medium" | "low";
  manifests: string[];
  stack: string[];
  packageScripts: Record<string, string>;
  checkCommands: string[];
  runCommands: string[];
  testCommands: string[];
  architectureNotes: string[];
  publicSurfaces: string[];
  missingValidation: string[];
  summarySource: "static" | "codex" | "greenfield";
  summaryError?: string;
}

export interface GreenfieldContext {
  projectName: string;
  goal: string;
  preferredProfile?: HarnessProfile;
  constraints?: string;
}

export interface ProjectProfilerOptions {
  repo: string;
  mode?: "existing" | "greenfield" | "auto";
  profile?: HarnessProfile | "auto";
  useCodexSummary?: boolean;
  greenfield?: GreenfieldContext;
  summaryProvider?: (staticProfile: ProjectProfile) => Promise<Partial<ProjectProfile> | null>;
}

const ignoredSegments = new Set([".git", ".agent-os", "node_modules", "dist", "build", "coverage", ".next", ".venv", "__pycache__"]);

export async function profileProject(options: ProjectProfilerOptions): Promise<ProjectProfile> {
  const repoRoot = resolve(options.repo);
  const mode = await detectProjectMode(repoRoot, options.mode ?? "auto");
  const staticProfile = mode === "greenfield" ? greenfieldProfile(repoRoot, options.greenfield, options.profile) : await staticExistingProfile(repoRoot, options.profile);
  if (mode === "greenfield" || options.useCodexSummary === false) return staticProfile;

  const provider = options.summaryProvider ?? codexSummaryProvider;
  let codex: Partial<ProjectProfile> | null = null;
  try {
    codex = await provider(staticProfile);
  } catch (error) {
    return {
      ...staticProfile,
      summaryError: error instanceof Error ? error.message : String(error)
    };
  }
  if (!codex) {
    return {
      ...staticProfile,
      summaryError: "Codex summary returned no structured JSON."
    };
  }
  return sanitizeProjectProfile({
    ...staticProfile,
    ...codex,
    repoRoot,
    mode,
    recommendedProfile: normalizeProfile(codex.recommendedProfile ?? staticProfile.recommendedProfile),
    summarySource: "codex"
  });
}

export async function detectProjectMode(repoRoot: string, requested: "existing" | "greenfield" | "auto" = "auto"): Promise<"existing" | "greenfield"> {
  if (requested === "existing" || requested === "greenfield") return requested;
  if (!(await exists(repoRoot))) return "greenfield";
  if (!(await isDirectory(repoRoot))) throw new Error(`project path is not a directory: ${repoRoot}`);
  const files = (await walkFiles(repoRoot)).filter((file) => !isIgnored(file, repoRoot));
  if (files.length === 0) return "greenfield";
  if (files.some((file) => importantProjectFile(file, repoRoot))) return "existing";
  return files.length <= 2 ? "greenfield" : "existing";
}

async function staticExistingProfile(repoRoot: string, requestedProfile?: HarnessProfile | "auto"): Promise<ProjectProfile> {
  const files = (await walkFiles(repoRoot)).filter((file) => !isIgnored(file, repoRoot));
  const relFiles = files.map((file) => relativeUnix(repoRoot, file));
  const manifests = relFiles.filter(isManifest);
  const packageJsonPath = join(repoRoot, "package.json");
  const packageJson = (await exists(packageJsonPath)) ? JSON.parse(await readText(packageJsonPath)) as Record<string, any> : null;
  const scripts = normalizeScripts(packageJson?.scripts);
  const has = (path: string) => relFiles.includes(path);
  const stack = new Set<string>();
  if (packageJson) stack.add("Node.js");
  if (has("tsconfig.json") || relFiles.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"))) stack.add("TypeScript");
  if (relFiles.some((file) => file.endsWith(".tsx") || file.endsWith(".jsx")) || packageJson?.dependencies?.react || packageJson?.devDependencies?.react) stack.add("Web");
  if (has("pyproject.toml") || relFiles.some((file) => file.endsWith(".py"))) stack.add("Python");
  if (relFiles.some((file) => /api|server|route|controller/i.test(file))) stack.add("API");

  const recommendedProfile = requestedProfile && requestedProfile !== "auto" ? requestedProfile : inferProfile(stack, relFiles, packageJson);
  return {
    repoRoot,
    mode: "existing",
    projectName: String(packageJson?.name ?? basename(repoRoot)),
    recommendedProfile,
    confidence: confidenceFor(recommendedProfile, stack, manifests),
    manifests,
    stack: [...stack],
    packageScripts: scripts,
    checkCommands: inferCheckCommands(scripts, relFiles),
    runCommands: inferRunCommands(scripts),
    testCommands: inferTestCommands(scripts, relFiles),
    architectureNotes: inferArchitectureNotes(relFiles),
    publicSurfaces: inferPublicSurfaces(relFiles),
    missingValidation: inferMissingValidation(scripts, relFiles),
    summarySource: "static"
  };
}

function greenfieldProfile(repoRoot: string, context: GreenfieldContext | undefined, requestedProfile?: HarnessProfile | "auto"): ProjectProfile {
  const profile = normalizeProfile(context?.preferredProfile ?? (requestedProfile === "auto" ? undefined : requestedProfile) ?? "base");
  return {
    repoRoot,
    mode: "greenfield",
    projectName: context?.projectName?.trim() || basename(repoRoot),
    recommendedProfile: profile,
    confidence: context?.preferredProfile || requestedProfile !== "auto" ? "high" : "medium",
    manifests: [],
    stack: profile === "base" ? [] : [profile],
    packageScripts: {},
    checkCommands: ["./scripts/agent-check.sh"],
    runCommands: [],
    testCommands: [],
    architectureNotes: [context?.goal ? `Goal: ${context.goal}` : "Greenfield project; product context supplied during setup."],
    publicSurfaces: [],
    missingValidation: ["Add project-specific tests and runtime checks once implementation begins."],
    summarySource: "greenfield"
  };
}

async function codexSummaryProvider(staticProfile: ProjectProfile): Promise<Partial<ProjectProfile> | null> {
  const outDir = await mkdtemp(join(tmpdir(), "agent-os-profile-"));
  const outPath = join(outDir, "summary.json");
  const prompt = [
    "Inspect this repository in read-only mode and return JSON only.",
    "Do not edit files. Do not run mutating commands.",
    "Schema:",
    JSON.stringify({
      projectName: "string",
      recommendedProfile: "base|typescript|python|web|api",
      confidence: "high|medium|low",
      stack: ["string"],
      checkCommands: ["string"],
      runCommands: ["string"],
      testCommands: ["string"],
      architectureNotes: ["string"],
      publicSurfaces: ["string"],
      missingValidation: ["string"]
    }),
    "",
    "Static profile:",
    JSON.stringify(staticProfile, null, 2)
  ].join("\n");
  try {
    await runCommand(
      "npx",
      [
        "-y",
        "@openai/codex@latest",
        "exec",
        "-c",
        'model_reasoning_effort="low"',
        "--cd",
        staticProfile.repoRoot,
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--output-last-message",
        outPath,
        prompt
      ],
      120_000
    );
    const text = await readFile(outPath, "utf8");
    const parsed = parseJsonObject(text);
    return parsed as Partial<ProjectProfile>;
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeProjectSummary(repoRoot: string, profile: ProjectProfile, dryRun = false): Promise<void> {
  if (dryRun) return;
  await writeTextEnsuringDir(join(repoRoot, ".agent-os", "setup-summary.json"), `${JSON.stringify(profile, null, 2)}\n`);
}

function inferProfile(stack: Set<string>, relFiles: string[], packageJson: Record<string, any> | null): HarnessProfile {
  if (stack.has("Web")) return "web";
  if (stack.has("API")) return "api";
  if (stack.has("Python")) return "python";
  if (stack.has("TypeScript") || packageJson) return "typescript";
  if (relFiles.some((file) => file.endsWith(".ts"))) return "typescript";
  return "base";
}

function confidenceFor(profile: HarnessProfile, stack: Set<string>, manifests: string[]): "high" | "medium" | "low" {
  if (profile !== "base" && manifests.length > 0) return "high";
  if (stack.size > 0) return "medium";
  return "low";
}

function inferCheckCommands(scripts: Record<string, string>, relFiles: string[]): string[] {
  const commands = [];
  if (scripts["agent-check"]) commands.push("npm run agent-check");
  if (scripts.typecheck) commands.push("npm run typecheck");
  if (scripts.lint) commands.push("npm run lint");
  if (scripts.test) commands.push("npm test");
  if (relFiles.includes("pyproject.toml")) commands.push("pytest");
  return commands.length ? commands : ["./scripts/agent-check.sh"];
}

function inferRunCommands(scripts: Record<string, string>): string[] {
  return ["dev", "start"].filter((name) => scripts[name]).map((name) => `npm run ${name}`);
}

function inferTestCommands(scripts: Record<string, string>, relFiles: string[]): string[] {
  const commands = [];
  if (scripts.test) commands.push("npm test");
  if (relFiles.includes("pyproject.toml")) commands.push("pytest");
  return commands;
}

function inferArchitectureNotes(relFiles: string[]): string[] {
  const notes = [];
  if (relFiles.some((file) => file.startsWith("src/"))) notes.push("Primary source appears under `src/`.");
  if (relFiles.some((file) => file.startsWith("tests/") || file.includes(".test."))) notes.push("Automated tests are present.");
  if (relFiles.some((file) => file.startsWith(".github/workflows/"))) notes.push("GitHub Actions workflows are present.");
  return notes.length ? notes : ["No obvious architecture docs or source layout detected by static scan."];
}

function inferPublicSurfaces(relFiles: string[]): string[] {
  const surfaces = [];
  if (relFiles.includes("package.json")) surfaces.push("package.json scripts and package entrypoints");
  if (relFiles.some((file) => file.startsWith("src/"))) surfaces.push("source modules under src/");
  if (relFiles.some((file) => file.startsWith("docs/"))) surfaces.push("docs/");
  if (relFiles.some((file) => file.startsWith(".github/workflows/"))) surfaces.push("GitHub Actions workflows");
  return surfaces;
}

function inferMissingValidation(scripts: Record<string, string>, relFiles: string[]): string[] {
  const missing = [];
  if (!scripts.test && !relFiles.some((file) => file.includes(".test.") || file.startsWith("tests/"))) missing.push("No obvious automated test command found.");
  if (!scripts.lint && relFiles.includes("package.json")) missing.push("No npm lint script found.");
  if (!scripts.typecheck && relFiles.includes("tsconfig.json")) missing.push("No npm typecheck script found.");
  return missing;
}

function sanitizeProjectProfile(profile: ProjectProfile): ProjectProfile {
  return {
    ...profile,
    architectureNotes: profile.architectureNotes.filter((note) => !isTransientSetupObservation(note))
  };
}

function isTransientSetupObservation(note: string): boolean {
  return [
    /worktree has .*uncommitted changes/i,
    /inspection was read-only/i,
    /no edits or mutating commands were run/i
  ].some((pattern) => pattern.test(note));
}

function importantProjectFile(file: string, repoRoot: string): boolean {
  return isManifest(relativeUnix(repoRoot, file)) || /\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|php|cs)$/.test(file);
}

function isManifest(path: string): boolean {
  return [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "tsconfig.json",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "vitest.config.ts",
    "pytest.ini",
    "Cargo.toml",
    "go.mod",
    "README.md"
  ].includes(path);
}

function normalizeScripts(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function isIgnored(file: string, repoRoot: string): boolean {
  return relativeUnix(repoRoot, file).split("/").some((segment) => ignoredSegments.has(segment));
}

function normalizeProfile(value: unknown): HarnessProfile {
  return value === "typescript" || value === "python" || value === "web" || value === "api" || value === "base" ? value : "base";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const raw = trimmed.startsWith("{") ? trimmed : trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (!raw) return null;
  return JSON.parse(raw) as Record<string, unknown>;
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command_timeout: ${command}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolvePromise() : reject(new Error(`command_failed: ${command} exit=${code}`));
    });
  });
}

function relativeUnix(from: string, to: string): string {
  return to.slice(resolve(from).length + 1).split("\\").join("/");
}
