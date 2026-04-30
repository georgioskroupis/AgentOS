import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { copyFileEnsuringDir, ensureDir, exists, makeExecutable, packageRoot, rel, walkFiles } from "./fs-utils.js";
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
  await ensureDir(targetRoot);

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
      changes.push({
        action: (await exists(target)) ? "exists" : "missing",
        path: relativePath,
        source
      });
    }
  }
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

