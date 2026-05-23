import type { IssueTracker } from "./types.js";

export interface TrackerReader {
  fetchCandidates: IssueTracker["fetchCandidates"];
  fetchIssueStates: IssueTracker["fetchIssueStates"];
  fetchTerminalIssues?: IssueTracker["fetchTerminalIssues"];
  fetchIssueComments?: IssueTracker["fetchIssueComments"];
}

export interface TrackerLifecycleWriter {
  comment?: IssueTracker["comment"];
  upsertComment?: IssueTracker["upsertComment"];
  move?: IssueTracker["move"];
}

export interface TrackerCapabilities extends TrackerReader, TrackerLifecycleWriter {}
