import { basename, join } from "node:path";
import { packageRoot, readText, rel, walkFiles } from "./fs-utils.js";
import type { LinearIssueReference, LinearProject, LinearState, LinearTeam } from "./linear.js";

export interface MaintenanceTemplate {
  slug: string;
  title: string;
  description: string;
  path: string;
}

export interface MaintenanceSeedClient {
  listTeams(): Promise<LinearTeam[]>;
  listWorkflowStates(teamId: string): Promise<LinearState[]>;
  findProject(slugOrName: string): Promise<LinearProject | null>;
  createProject(name: string, teamId: string): Promise<LinearProject>;
  createIssue(input: {
    teamId: string;
    title: string;
    description: string;
    projectId?: string;
    stateId?: string;
  }): Promise<Pick<LinearIssueReference, "id" | "identifier"> & { title: string }>;
}

export interface MaintenanceSeedResult {
  team: LinearTeam;
  state: LinearState;
  project: LinearProject;
  templates: MaintenanceTemplate[];
  issues: Array<Pick<LinearIssueReference, "id" | "identifier"> & { title: string }>;
}

export async function loadMaintenanceTemplates(root = packageRoot()): Promise<MaintenanceTemplate[]> {
  const templateRoot = join(root, "templates", "maintenance");
  const files = (await walkFiles(templateRoot)).filter((path) => path.endsWith(".md") && !basename(path).startsWith("_"));
  const templates = await Promise.all(files.map((path) => parseMaintenanceTemplate(root, path)));
  return templates.sort((left, right) => left.slug.localeCompare(right.slug));
}

export async function seedMaintenanceIssues(
  client: MaintenanceSeedClient,
  options: { team: string; project: string; state?: string; root?: string }
): Promise<MaintenanceSeedResult> {
  const teams = await client.listTeams();
  const team = teams.find((candidate) => candidate.id === options.team || candidate.key === options.team);
  if (!team) throw new Error(`Linear team not found: ${options.team}`);

  const states = await client.listWorkflowStates(team.id);
  const stateName = options.state ?? "Backlog";
  const state = states.find((candidate) => candidate.name.toLowerCase() === stateName.toLowerCase());
  if (!state) throw new Error(`Linear state not found for team ${team.key}: ${stateName}`);

  const project = (await client.findProject(options.project)) ?? (await client.createProject(options.project, team.id));
  const templates = await loadMaintenanceTemplates(options.root);
  const issues = [];
  for (const template of templates) {
    issues.push(
      await client.createIssue({
        teamId: team.id,
        title: template.title,
        description: template.description,
        projectId: project.id,
        stateId: state.id
      })
    );
  }

  return { team, state, project, templates, issues };
}

async function parseMaintenanceTemplate(root: string, path: string): Promise<MaintenanceTemplate> {
  const text = (await readText(path)).replace(/\r\n/g, "\n").trim();
  const titleMatch = text.match(/^#\s+(.+?)\s*$/m);
  if (!titleMatch) {
    throw new Error(`maintenance template missing H1 title: ${rel(root, path)}`);
  }
  const description = text.replace(/^#\s+.+?\s*$(\n+)?/m, "").trim();
  return {
    slug: basename(path, ".md"),
    title: titleMatch[1],
    description: `${description}\n`,
    path: rel(root, path)
  };
}
