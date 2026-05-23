import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { agentTrackerMarker } from "./agent-lifecycle.js";
import { pullRequestUrls } from "./issue-state.js";
import type { AgentOwnedLifecycleEvidence, AgentOwnedLifecycleEvidenceMarkerCheck, AgentOwnedLifecycleMarkerFinding } from "./agentOwnedEvidenceTypes.js";
import type { IssueComment, IssueState, ServiceConfig, ValidationState } from "./types.js";

export interface VerifyAgentOwnedLifecycleEvidenceInput {
  config: ServiceConfig;
  issueIdentifier: string;
  runId: string;
  attempt: number | null;
  expectedState: string;
  observedState: string | null;
  comments: IssueComment[] | null;
  handoff: string | null;
  handoffPath: string;
  workspacePath: string;
  state?: IssueState | null;
  validation?: ValidationState | null;
  checkedAt?: string;
  expectedAuthors?: string[];
}

interface ParsedLifecycleMarker {
  event: string;
  issue: string;
  run: string;
  attempt: string;
  marker: string;
  comment: IssueComment;
}

export function verifyAgentOwnedLifecycleEvidence(input: VerifyAgentOwnedLifecycleEvidenceInput): AgentOwnedLifecycleEvidence {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const prUrls = pullRequestUrls(input.state);
  const requiredEvents = ["run_started", "run_handoff", ...(prUrls.length ? ["pr_metadata"] : [])];
  const markerRegex = markerRegexForFormat(input.config.lifecycle.idempotencyMarkerFormat);
  const parsedMarkers = markerRegex && input.comments ? parseLifecycleMarkers(input.comments, markerRegex) : [];
  const missing: string[] = [];
  const duplicateMarkers: AgentOwnedLifecycleMarkerFinding[] = [];
  const staleEvidence: AgentOwnedLifecycleMarkerFinding[] = [];
  const wrongIssue: AgentOwnedLifecycleMarkerFinding[] = [];
  const wrongRun: AgentOwnedLifecycleMarkerFinding[] = [];
  const wrongAuthor: AgentOwnedLifecycleMarkerFinding[] = [];
  const expectedAuthors = normalizeExpectedAuthors(input.expectedAuthors ?? []);

  if (!input.comments) missing.push("tracker_comments_unavailable");

  const requiredMarkers: AgentOwnedLifecycleEvidenceMarkerCheck[] = requiredEvents.map((event) => {
    const marker = agentTrackerMarker(input.config, event, input.issueIdentifier, { runId: input.runId, attempt: input.attempt });
    const exactMatches = (input.comments ?? []).filter((comment) => comment.body.includes(marker));
    const parsedEventMatches = parsedMarkers.filter((entry) => entry.event === event);
    if (exactMatches.length === 0) missing.push(`marker:${event}`);
    if (exactMatches.length > 1) {
      duplicateMarkers.push({
        event,
        marker,
        commentIds: exactMatches.map((comment) => comment.id),
        authors: exactMatches.map(commentAuthorLabel).filter(Boolean)
      });
    }
    for (const entry of parsedEventMatches) {
      if (entry.issue === input.issueIdentifier && entry.run !== input.runId) {
        staleEvidence.push(markerFindingFromEntry(entry, "run mismatch"));
      }
      if (entry.issue !== input.issueIdentifier) {
        wrongIssue.push(markerFindingFromEntry(entry, `expected issue ${input.issueIdentifier}`));
      }
      if (entry.issue === input.issueIdentifier && entry.run !== input.runId && entry.run !== "manual") {
        wrongRun.push(markerFindingFromEntry(entry, `expected run ${input.runId}`));
      }
      if (expectedAuthors.length > 0 && !expectedAuthors.includes(normalizeAuthor(entry.comment))) {
        wrongAuthor.push(markerFindingFromEntry(entry, "unexpected author"));
      }
    }
    return {
      event,
      marker,
      found: exactMatches.length > 0,
      count: exactMatches.length,
      commentIds: exactMatches.map((comment) => comment.id)
    };
  });

  if (!input.handoff) missing.push("handoff");
  if (!sameState(input.observedState, input.expectedState)) missing.push(`state:${input.expectedState}`);

  const validationEvidence = validationEvidenceFor(input.validation, input.workspacePath);
  if (!validationEvidence.found) missing.push("validation_evidence");
  if (validationEvidence.status !== "passed" || validationEvidence.finalStatus === "failed") missing.push("validation_evidence_passed");
  if (validationEvidence.runId && validationEvidence.runId !== input.runId) {
    wrongRun.push({
      event: "validation_evidence",
      marker: validationEvidence.path ?? "validation_evidence",
      commentIds: [],
      reason: `expected run ${input.runId}`,
      observedRun: validationEvidence.runId
    });
  }

  const uniqueMissing = uniqueStrings(missing);
  const allWrongRun = dedupeFindings([...wrongRun, ...staleEvidence.filter((finding) => finding.observedRun && finding.observedRun !== input.runId)]);
  const failed =
    uniqueMissing.length > 0 ||
    duplicateMarkers.length > 0 ||
    staleEvidence.length > 0 ||
    wrongIssue.length > 0 ||
    allWrongRun.length > 0 ||
    wrongAuthor.length > 0;

  return {
    schemaVersion: 1,
    status: failed ? "failed" : "passed",
    checkedAt,
    issueIdentifier: input.issueIdentifier,
    runId: input.runId,
    attempt: input.attempt,
    expectedState: input.expectedState,
    observedState: input.observedState,
    requiredMarkers,
    handoffPath: input.handoffPath,
    handoffFound: Boolean(input.handoff),
    validationEvidence,
    prUrls,
    missing: uniqueMissing,
    staleEvidence: dedupeFindings(staleEvidence),
    duplicateMarkers: dedupeFindings(duplicateMarkers),
    wrongAuthor: dedupeFindings(wrongAuthor),
    wrongIssue: dedupeFindings(wrongIssue),
    wrongRun: allWrongRun
  };
}

export function agentOwnedLifecycleEvidenceFailureMessage(evidence: AgentOwnedLifecycleEvidence): string {
  const details = [
    ...evidence.missing,
    ...evidence.duplicateMarkers.map((finding) => `duplicate:${finding.event}`),
    ...evidence.staleEvidence.map((finding) => `stale:${finding.event}`),
    ...evidence.wrongAuthor.map((finding) => `wrong_author:${finding.event}`),
    ...evidence.wrongIssue.map((finding) => `wrong_issue:${finding.event}`),
    ...evidence.wrongRun.map((finding) => `wrong_run:${finding.event}`)
  ];
  return `agent_owned_lifecycle_missing_evidence${details.length ? `: ${uniqueStrings(details).join(", ")}` : ""}`;
}

function validationEvidenceFor(validation: ValidationState | null | undefined, workspacePath: string): AgentOwnedLifecycleEvidence["validationEvidence"] {
  const path = validation?.path;
  return {
    ...(path ? { path } : {}),
    found: Boolean(path && existsSync(isAbsolute(path) ? path : join(workspacePath, path))),
    status: validation?.status ?? "missing",
    ...(validation?.finalStatus ? { finalStatus: validation.finalStatus } : {}),
    ...(validation?.runId ? { runId: validation.runId } : {}),
    ...(validation?.errors?.length ? { errors: validation.errors } : {}),
    ...(validation?.acceptedCommands ? { acceptedCommands: validation.acceptedCommands.map((command) => command.name) } : {})
  };
}

function markerRegexForFormat(format: string | null | undefined): RegExp | null {
  if (!format) return null;
  const tokenPattern = "(?<TOKEN>[A-Za-z0-9._:-]+)";
  const pattern = escapeRegex(format)
    .replaceAll("\\{event\\}", tokenPattern.replace("TOKEN", "event"))
    .replaceAll("\\{issue\\}", tokenPattern.replace("TOKEN", "issue"))
    .replaceAll("\\{run\\}", tokenPattern.replace("TOKEN", "run"))
    .replaceAll("\\{attempt\\}", tokenPattern.replace("TOKEN", "attempt"));
  try {
    return new RegExp(pattern, "g");
  } catch {
    return null;
  }
}

function parseLifecycleMarkers(comments: IssueComment[], regex: RegExp): ParsedLifecycleMarker[] {
  const markers: ParsedLifecycleMarker[] = [];
  for (const comment of comments) {
    regex.lastIndex = 0;
    for (const match of comment.body.matchAll(regex)) {
      const groups = match.groups;
      if (!groups?.event || !groups.issue || !groups.run || !groups.attempt) continue;
      markers.push({
        event: groups.event,
        issue: groups.issue,
        run: groups.run,
        attempt: groups.attempt,
        marker: match[0],
        comment
      });
    }
  }
  return markers;
}

function markerFindingFromEntry(entry: ParsedLifecycleMarker, reason: string): AgentOwnedLifecycleMarkerFinding {
  return {
    event: entry.event,
    marker: entry.marker,
    commentIds: [entry.comment.id],
    authors: [commentAuthorLabel(entry.comment)].filter(Boolean),
    reason,
    observedIssue: entry.issue,
    observedRun: entry.run
  };
}

function normalizeExpectedAuthors(authors: string[]): string[] {
  return authors.map((author) => author.trim().toLowerCase()).filter(Boolean);
}

function normalizeAuthor(comment: IssueComment): string {
  return (comment.authorEmail ?? comment.authorId ?? comment.author ?? "").trim().toLowerCase();
}

function commentAuthorLabel(comment: IssueComment): string {
  return comment.authorEmail ?? comment.authorId ?? comment.author ?? "";
}

function sameState(left: string | null, right: string): boolean {
  return (left ?? "").trim().toLowerCase() === right.trim().toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeFindings(findings: AgentOwnedLifecycleMarkerFinding[]): AgentOwnedLifecycleMarkerFinding[] {
  const seen = new Set<string>();
  const unique: AgentOwnedLifecycleMarkerFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.event}:${finding.marker}:${finding.commentIds.join(",")}:${finding.reason ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return unique;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
