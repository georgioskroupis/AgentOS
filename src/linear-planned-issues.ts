import YAML from "yaml";
import { redactText } from "./redaction.js";
import type { LinearProject, LinearState, LinearTeam } from "./linear.js";
import type {
  LinearPlannedIssueAdapter,
  LinearPlannedIssueLookupOptions,
  LinearPlannedIssueReference,
  LinearPlannedIssueWriteInput,
  PlannedIssueKind,
  PlannedIssueRelationInput,
  PlannedIssueRelationType,
  PlannedIssueWriteAction
} from "./linear-planned-issue-types.js";
export type {
  LinearPlannedIssueAdapter,
  LinearPlannedIssueLookupOptions,
  LinearPlannedIssueReference,
  LinearPlannedIssueWriteInput,
  PlannedIssueKind,
  PlannedIssueRelationInput,
  PlannedIssueRelationType,
  PlannedIssueWriteAction
} from "./linear-planned-issue-types.js";

export interface PlannedIssuePlan {
  parentIssue?: string;
  team?: string;
  project?: string;
  state?: string;
  issues: PlannedIssueSpec[];
}

export interface PlannedIssueSpec {
  kind: PlannedIssueKind;
  marker?: string;
  title: string;
  goal?: string;
  scope?: string[];
  context?: string[];
  outOfScope?: string[];
  acceptanceCriteria: string[];
  validation?: string[];
  proof?: string[];
  relevantFiles?: string[];
  blockedBy?: string[];
  blocks?: string[];
  related?: string[];
  parentIssue?: string;
  assigneeId?: string;
  trustedDecisionActor?: string;
}

export interface UpsertPlannedIssuesOptions {
  apiKey?: string;
  projectSlug?: string;
  parentIssue?: string;
  team?: string;
  project?: string;
  state?: string;
  assigneeId?: string;
  trustedDecisionActor?: string;
  maxAcceptanceCriteria?: number;
}

export interface UpsertPlannedIssuesResult {
  parent: LinearPlannedIssueReference | null;
  project: LinearProject;
  issues: UpsertPlannedIssueResult[];
  relations: PlannedIssueRelationResult[];
}

export interface UpsertPlannedIssueResult {
  marker: string;
  markerText: string;
  kind: PlannedIssueKind;
  action: PlannedIssueWriteAction;
  id: string;
  identifier: string;
  title: string;
  url?: string | null;
}

export interface PlannedIssueRelationResult {
  issueId: string;
  relatedIssueId: string;
  type: PlannedIssueRelationType;
}

interface ResolvedPlannedIssue {
  spec: PlannedIssueSpec;
  marker: string;
  markerText: string;
  parent: LinearPlannedIssueReference | null;
  team: LinearTeam;
  project: LinearProject;
  state: LinearState | null;
  assigneeId: string | null;
  continuity: string;
  siblingMarkers: string[];
}

export function parseLinearPlannedIssueInput(text: string): PlannedIssuePlan {
  const parsed = YAML.parse(text) as unknown;
  if (!isRecord(parsed)) throw new Error("linear_plan_input_not_a_map");
  const childIssues = arrayAt(parsed, "child_issues", "childIssues").map((item) => normalizePlannedIssue(item, "child"));
  const followUpIssues = arrayAt(parsed, "follow_up_issues", "followUpIssues", "followups", "follow_ups").map((item) =>
    normalizePlannedIssue(item, "follow-up")
  );
  const mixedIssues = arrayAt(parsed, "issues", "planned_issues", "plannedIssues").map((item) => normalizePlannedIssue(item, null));
  const issues = [...childIssues, ...followUpIssues, ...mixedIssues];
  if (issues.length === 0) throw new Error("linear_plan_input_has_no_issues");
  return {
    parentIssue: stringAt(parsed, "parent_issue", "parentIssue", "parent"),
    team: stringAt(parsed, "team"),
    project: stringAt(parsed, "project"),
    state: stringAt(parsed, "state"),
    issues
  };
}

export async function upsertLinearPlannedIssues(
  adapter: LinearPlannedIssueAdapter,
  plan: PlannedIssuePlan,
  options: UpsertPlannedIssuesOptions = {}
): Promise<UpsertPlannedIssuesResult> {
  assertPlanPrerequisites(plan, options);
  const projectName = options.project ?? plan.project ?? options.projectSlug;
  if (!projectName) throw new Error("linear_plan_missing_project: set --project or tracker.project_slug");
  const project = await adapter.findProject(projectName);
  if (!project) throw new Error(`linear_plan_project_not_found: ${projectName}`);

  const resolved: ResolvedPlannedIssue[] = [];
  const resultIssues: UpsertPlannedIssueResult[] = [];
  const byMarker = new Map<string, UpsertPlannedIssueResult>();
  let firstParent: LinearPlannedIssueReference | null = null;

  for (const spec of plan.issues) {
    const item = await resolvePlannedIssue(adapter, spec, plan, options, project);
    if (!firstParent && item.parent) firstParent = item.parent;
    resolved.push(item);
  }
  assertUniqueResolvedMarkers(resolved);
  for (const item of resolved) {
    item.siblingMarkers = resolved.map((candidate) => candidate.marker).filter((marker) => marker !== item.marker);
  }

  for (const item of resolved) {
    const existing = await adapter.findIssueByPlanningMarker(item.markerText, projectLookup(item.project));
    const writeInput = plannedIssueWriteInput(item);
    const issue = existing ? await adapter.updateIssue(existing.id, writeInput) : await adapter.createIssue(writeInput);
    const result: UpsertPlannedIssueResult = {
      marker: item.marker,
      markerText: item.markerText,
      kind: item.spec.kind,
      action: existing ? "updated" : "created",
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title ?? item.spec.title,
      url: issue.url ?? null
    };
    resultIssues.push(result);
    byMarker.set(item.marker, result);
  }

  const relations: PlannedIssueRelationResult[] = [];
  for (const issue of resolved) {
    const written = byMarker.get(issue.marker);
    if (!written) continue;
    for (const ref of issue.spec.blockedBy ?? []) {
      const relatedIssueId = await resolveRelationIssueId(adapter, byMarker, ref, issue.project);
      await ensureIssueRelation(adapter, { issueId: relatedIssueId, relatedIssueId: written.id, type: "blocks" });
      relations.push({ issueId: relatedIssueId, relatedIssueId: written.id, type: "blocks" });
    }
    for (const ref of issue.spec.blocks ?? []) {
      const relatedIssueId = await resolveRelationIssueId(adapter, byMarker, ref, issue.project);
      await ensureIssueRelation(adapter, { issueId: written.id, relatedIssueId, type: "blocks" });
      relations.push({ issueId: written.id, relatedIssueId, type: "blocks" });
    }
    for (const ref of issue.spec.related ?? []) {
      const relatedIssueId = await resolveRelationIssueId(adapter, byMarker, ref, issue.project);
      await ensureIssueRelation(adapter, { issueId: written.id, relatedIssueId, type: "related" });
      relations.push({ issueId: written.id, relatedIssueId, type: "related" });
    }
  }

  return { parent: firstParent, project, issues: resultIssues, relations };
}

export function plannedIssueMarker(marker: string): string {
  const trimmed = marker.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.includes("-->")) {
    throw new Error(`linear_plan_invalid_marker: ${redactText(marker)}`);
  }
  return `<!-- agentos:planned-issue=${trimmed} -->`;
}

export function formatLinearPlannedIssuesResult(result: UpsertPlannedIssuesResult): string {
  const lines = [`planned issues: ${result.issues.length}`, `project: ${result.project.slugId ?? result.project.name}`];
  if (result.parent) lines.push(`parent: ${result.parent.identifier}`);
  for (const issue of result.issues) {
    lines.push(`${issue.action}: ${issue.identifier} ${issue.kind} marker=${issue.marker}`);
    if (issue.url) lines.push(`url: ${issue.url}`);
  }
  if (result.relations.length > 0) lines.push(`relations: ${result.relations.length}`);
  return lines.join("\n");
}

export function formatLinearPlanError(error: unknown): Error {
  return new Error(redactText(error instanceof Error ? error.message : String(error)));
}

async function resolvePlannedIssue(
  adapter: LinearPlannedIssueAdapter,
  spec: PlannedIssueSpec,
  plan: PlannedIssuePlan,
  options: UpsertPlannedIssuesOptions,
  project: LinearProject
): Promise<ResolvedPlannedIssue> {
  const boundedSpec = enforceSmallCriteriaSet(spec, options.maxAcceptanceCriteria ?? 4);
  const parentRef = boundedSpec.parentIssue ?? plan.parentIssue ?? options.parentIssue;
  if (boundedSpec.kind === "child" && !parentRef) throw new Error(`linear_plan_missing_parent: child issue "${boundedSpec.title}" requires a parent issue`);
  const parent = parentRef ? await adapter.findIssueReference(parentRef, projectLookup(project)) : null;
  const team = parent?.team ?? (await resolveTeam(adapter, options.team ?? plan.team));
  const stateName = options.state ?? plan.state;
  const state = stateName ? await resolveState(adapter, team, stateName) : null;
  const marker = boundedSpec.marker ?? derivedMarker(parent?.identifier ?? parentRef ?? team.key, boundedSpec.kind, boundedSpec.title);
  const trustedDecisionActor = boundedSpec.trustedDecisionActor ?? options.trustedDecisionActor;
  const assignee = boundedSpec.assigneeId ?? options.assigneeId ?? parent?.assigneeId ?? null;
  if (!assignee && !trustedDecisionActor) {
    throw new Error(
      `linear_plan_missing_trusted_decision_continuity: "${boundedSpec.title}" needs an assignee_id, --assignee, trusted_decision_actor, or an assigned parent issue`
    );
  }
  const continuity = assignee
    ? assignee === parent?.assigneeId
      ? `Assignee inherited from parent issue (${assignee}).`
      : `Assignee set explicitly (${assignee}).`
    : `Trusted decision actor noted for supervisor continuity (${trustedDecisionActor}).`;
  const markerText = plannedIssueMarker(marker);
  return {
    spec: boundedSpec,
    marker,
    markerText,
    parent,
    team,
    project,
    state,
    assigneeId: assignee,
    continuity,
    siblingMarkers: []
  };
}

function plannedIssueWriteInput(issue: ResolvedPlannedIssue): LinearPlannedIssueWriteInput {
  return {
    teamId: issue.team.id,
    title: issue.spec.title,
    description: plannedIssueDescription(issue),
    projectId: issue.project.id,
    stateId: issue.state?.id,
    parentId: issue.spec.kind === "child" ? issue.parent?.id : issue.spec.parentIssue ? issue.parent?.id : undefined,
    assigneeId: issue.assigneeId ?? undefined
  };
}

function plannedIssueDescription(issue: ResolvedPlannedIssue): string {
  const criteria = issue.spec.acceptanceCriteria.map((item) => `- ${item}`);
  const context = [
    issue.spec.goal ? `Goal: ${issue.spec.goal}` : null,
    issue.parent ? `Parent issue: ${issue.parent.identifier}${issue.parent.url ? ` (${issue.parent.url})` : ""}` : null,
    issue.continuity,
    ...linesWithPrefix("Relevant files", issue.spec.relevantFiles),
    ...linesWithPrefix("Validation", issue.spec.validation),
    ...linesWithPrefix("Proof", issue.spec.proof),
    ...(issue.spec.context ?? []).map((line) => `Background: ${line}`)
  ].filter((line): line is string => Boolean(line));
  const evidence = {
    marker: issue.marker,
    kind: issue.spec.kind,
    parent: issue.parent?.identifier ?? null,
    siblings: issue.siblingMarkers,
    blockedBy: issue.spec.blockedBy ?? [],
    blocks: issue.spec.blocks ?? [],
    related: issue.spec.related ?? []
  };
  return [
    issue.markerText,
    "",
    "Active scope:",
    compactText(issue.spec.scope?.length ? issue.spec.scope : [issue.spec.goal ?? issue.spec.title]),
    "",
    "Done when:",
    ...(criteria.length ? criteria : ["- Active scope is complete and validated."]),
    "",
    "Context:",
    ...(context.length ? context : ["Background intentionally kept outside Active scope."]),
    "",
    "Out of scope:",
    ...(issue.spec.outOfScope?.length ? issue.spec.outOfScope.map((item) => `- ${item}`) : ["- Broader follow-up work not named above."]),
    "",
    "Decomposition evidence:",
    "```json",
    JSON.stringify(evidence, null, 2),
    "```"
  ].join("\n");
}

async function resolveTeam(adapter: LinearPlannedIssueAdapter, teamKeyOrId: string | undefined): Promise<LinearTeam> {
  if (!teamKeyOrId) throw new Error("linear_plan_missing_team: set --team or provide a parent issue");
  const teams = await adapter.listTeams();
  const team = teams.find((candidate) => candidate.id === teamKeyOrId || candidate.key === teamKeyOrId);
  if (!team) throw new Error(`linear_plan_team_not_found: ${teamKeyOrId}`);
  return team;
}

async function resolveState(adapter: LinearPlannedIssueAdapter, team: LinearTeam, stateName: string): Promise<LinearState> {
  const states = await adapter.listWorkflowStates(team.id);
  const state = states.find((candidate) => candidate.name.toLowerCase() === stateName.toLowerCase());
  if (!state) throw new Error(`linear_plan_state_not_found: ${stateName}`);
  return state;
}

async function resolveRelationIssueId(
  adapter: LinearPlannedIssueAdapter,
  byMarker: Map<string, UpsertPlannedIssueResult>,
  ref: string,
  project: LinearProject
): Promise<string> {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("linear_plan_missing_relation_issue_id");
  const planned = byMarker.get(trimmed);
  if (planned) return planned.id;
  return (await adapter.findIssueReference(trimmed, projectLookup(project))).id;
}

async function ensureIssueRelation(adapter: LinearPlannedIssueAdapter, input: PlannedIssueRelationInput): Promise<void> {
  if (adapter.findIssueRelation && (await adapter.findIssueRelation(input))) return;
  try {
    await adapter.createIssueRelation(input);
  } catch (error) {
    if (isDuplicateRelationError(error)) return;
    throw error;
  }
}

function assertUniqueResolvedMarkers(issues: ResolvedPlannedIssue[]): void {
  const seen = new Map<string, ResolvedPlannedIssue>();
  for (const issue of issues) {
    const existing = seen.get(issue.markerText);
    if (existing) {
      throw new Error(
        `linear_plan_duplicate_marker: ${redactText(issue.marker)} used by "${existing.spec.title}" and "${issue.spec.title}"`
      );
    }
    seen.set(issue.markerText, issue);
  }
}

function projectLookup(project: LinearProject): LinearPlannedIssueLookupOptions {
  return { project: project.slugId ?? project.name };
}

function isDuplicateRelationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate|already exists|already has|relation.*exists|must be unique/i.test(message);
}

function assertPlanPrerequisites(plan: PlannedIssuePlan, options: UpsertPlannedIssuesOptions): void {
  if (!options.apiKey) throw new Error("linear_plan_missing_credentials: tracker.api_key or LINEAR_API_KEY is required");
  if (plan.issues.length === 0) throw new Error("linear_plan_input_has_no_issues");
}

function enforceSmallCriteriaSet(spec: PlannedIssueSpec, max: number): PlannedIssueSpec {
  if (spec.acceptanceCriteria.length > max) {
    throw new Error(`linear_plan_too_many_acceptance_criteria: "${spec.title}" has ${spec.acceptanceCriteria.length}; split it or keep at most ${max}`);
  }
  return spec;
}

function normalizePlannedIssue(value: unknown, fallbackKind: PlannedIssueKind | null): PlannedIssueSpec {
  if (!isRecord(value)) throw new Error("linear_plan_issue_not_a_map");
  const kind = normalizeKind(stringAt(value, "kind", "type"), fallbackKind);
  const title = stringAt(value, "title");
  if (!title) throw new Error("linear_plan_issue_missing_title");
  return {
    kind,
    marker: stringAt(value, "marker", "idempotency_marker", "idempotencyMarker", "key"),
    title,
    goal: stringAt(value, "goal"),
    scope: stringListAt(value, "active_scope", "activeScope", "scope"),
    context: stringListAt(value, "context", "background"),
    outOfScope: stringListAt(value, "out_of_scope", "outOfScope", "non_goals", "nonGoals"),
    acceptanceCriteria: stringListAt(value, "acceptance_criteria", "acceptanceCriteria", "done_when", "doneWhen"),
    validation: stringListAt(value, "validation"),
    proof: stringListAt(value, "proof"),
    relevantFiles: stringListAt(value, "relevant_files", "relevantFiles"),
    blockedBy: stringListAt(value, "blocked_by", "blockedBy"),
    blocks: stringListAt(value, "blocks", "unblocks"),
    related: stringListAt(value, "related"),
    parentIssue: stringAt(value, "parent_issue", "parentIssue", "parent"),
    assigneeId: stringAt(value, "assignee_id", "assigneeId", "assignee"),
    trustedDecisionActor: stringAt(value, "trusted_decision_actor", "trustedDecisionActor", "trusted_actor", "trustedActor")
  };
}

function normalizeKind(value: string | undefined, fallback: PlannedIssueKind | null): PlannedIssueKind {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) {
    if (fallback) return fallback;
    throw new Error("linear_plan_issue_missing_kind");
  }
  if (normalized === "child") return "child";
  if (normalized === "follow-up" || normalized === "followup") return "follow-up";
  throw new Error(`linear_plan_issue_invalid_kind: ${value}`);
}

function stringAt(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return undefined;
}

function stringListAt(value: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (Array.isArray(item)) return item.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  return [];
}

function arrayAt(value: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const item = value[key];
    if (Array.isArray(item)) return item;
  }
  return [];
}

function derivedMarker(parentKey: string, kind: PlannedIssueKind, title: string): string {
  return `${parentKey}-${kind}-${title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function compactText(lines: string[]): string {
  return lines.map((line) => line.trim()).filter(Boolean).join(" ");
}

function linesWithPrefix(label: string, values: string[] | undefined): string[] {
  return (values ?? []).map((value) => `${label}: ${value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
