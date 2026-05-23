export interface AgentOwnedLifecycleEvidence {
  schemaVersion: 1;
  status: "passed" | "failed";
  checkedAt: string;
  issueIdentifier: string;
  runId: string;
  attempt: number | null;
  expectedState: string;
  observedState: string | null;
  requiredMarkers: AgentOwnedLifecycleEvidenceMarkerCheck[];
  handoffPath: string;
  handoffFound: boolean;
  validationEvidence: {
    path?: string;
    found: boolean;
    status: "passed" | "failed" | "missing";
    finalStatus?: "passed" | "failed";
    runId?: string;
    errors?: string[];
    acceptedCommands?: string[];
  };
  prUrls: string[];
  missing: string[];
  staleEvidence: AgentOwnedLifecycleMarkerFinding[];
  duplicateMarkers: AgentOwnedLifecycleMarkerFinding[];
  wrongAuthor: AgentOwnedLifecycleMarkerFinding[];
  wrongIssue: AgentOwnedLifecycleMarkerFinding[];
  wrongRun: AgentOwnedLifecycleMarkerFinding[];
}

export interface AgentOwnedLifecycleEvidenceMarkerCheck {
  event: string;
  marker: string;
  found: boolean;
  count: number;
  commentIds: string[];
}

export interface AgentOwnedLifecycleMarkerFinding {
  event: string;
  marker: string;
  commentIds: string[];
  authors?: string[];
  reason?: string;
  observedIssue?: string;
  observedRun?: string;
}
