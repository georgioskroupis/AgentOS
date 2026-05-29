import type { LinearIssueReference, LinearProject, LinearState, LinearTeam } from "./linear.js";

export type PlannedIssueKind = "child" | "follow-up";
export type PlannedIssueWriteAction = "created" | "updated";
export type PlannedIssueRelationType = "blocks" | "related";

export interface LinearPlannedIssueReference extends LinearIssueReference {
  title: string;
  url?: string | null;
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  project?: LinearProject | null;
}

export interface LinearPlannedIssueAdapter {
  listTeams(): Promise<LinearTeam[]>;
  listWorkflowStates(teamId: string): Promise<LinearState[]>;
  findProject(slugOrName: string): Promise<LinearProject | null>;
  findIssueReference(issueIdentifierOrId: string, options?: LinearPlannedIssueLookupOptions): Promise<LinearPlannedIssueReference>;
  findIssueByPlanningMarker(markerText: string, options?: LinearPlannedIssueLookupOptions): Promise<LinearPlannedIssueReference | null>;
  createIssue(input: LinearPlannedIssueWriteInput): Promise<LinearPlannedIssueReference>;
  updateIssue(issueId: string, input: LinearPlannedIssueWriteInput): Promise<LinearPlannedIssueReference>;
  findIssueRelation?(input: PlannedIssueRelationInput): Promise<boolean>;
  createIssueRelation(input: PlannedIssueRelationInput): Promise<void>;
}

export interface LinearPlannedIssueLookupOptions {
  project?: string;
}

export interface LinearPlannedIssueWriteInput {
  teamId: string;
  title: string;
  description: string;
  projectId?: string;
  stateId?: string;
  parentId?: string;
  assigneeId?: string;
}

export interface PlannedIssueRelationInput {
  issueId: string;
  relatedIssueId: string;
  type: PlannedIssueRelationType;
}
