import { resolve } from "node:path";
import YAML from "yaml";
import { exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import type { HarnessProfile, ProjectConfig, ProjectRegistry } from "./types.js";

export const registryFileName = "agent-os.yml";

export async function loadRegistry(path = registryFileName): Promise<ProjectRegistry> {
  const resolved = resolve(path);
  if (!(await exists(resolved))) {
    return {
      version: 1,
      defaults: {
        prProvider: "github",
        workspaceRoot: ".agent-os/workspaces"
      },
      projects: []
    };
  }
  const parsed = YAML.parse(await readText(resolved)) as ProjectRegistry | null;
  return {
    version: 1,
    defaults: parsed?.defaults ?? { prProvider: "github", workspaceRoot: ".agent-os/workspaces" },
    projects: parsed?.projects ?? []
  };
}

export async function saveRegistry(registry: ProjectRegistry, path = registryFileName): Promise<void> {
  await writeTextEnsuringDir(resolve(path), YAML.stringify(registry));
}

export async function addProject(input: {
  name: string;
  repo: string;
  workflow?: string;
  harnessProfile?: HarnessProfile;
  projectSlug?: string;
  maxConcurrency?: number;
  registryPath?: string;
}): Promise<ProjectRegistry> {
  const registry = await loadRegistry(input.registryPath);
  const nextProject: ProjectConfig = {
    name: input.name,
    repo: input.repo,
    workflow: input.workflow ?? "WORKFLOW.md",
    harnessProfile: input.harnessProfile ?? "base",
    tracker: input.projectSlug ? { kind: "linear", projectSlug: input.projectSlug } : undefined,
    maxConcurrency: input.maxConcurrency ?? 1
  };
  registry.projects = registry.projects.filter((project) => project.name !== input.name);
  registry.projects.push(nextProject);
  await saveRegistry(registry, input.registryPath);
  return registry;
}

export async function removeProject(name: string, registryPath?: string): Promise<ProjectRegistry> {
  const registry = await loadRegistry(registryPath);
  registry.projects = registry.projects.filter((project) => project.name !== name);
  await saveRegistry(registry, registryPath);
  return registry;
}
