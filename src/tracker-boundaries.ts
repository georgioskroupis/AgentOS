import type { IssueTracker } from "./types.js";
export type { LinearAdminClient, PlanningIssueReader, PlanningIssueWriter } from "./linear-planned-issue-types.js";

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

export interface SchedulerSafetyWriter extends TrackerLifecycleWriter {}

export interface AgentLifecycleWriter extends TrackerLifecycleWriter {}

export interface TrackerCapabilities extends TrackerReader, TrackerLifecycleWriter {}

export interface SplitTrackerCapabilities {
  reader: TrackerReader;
  schedulerSafetyWriter: SchedulerSafetyWriter;
  agentLifecycleWriter: AgentLifecycleWriter;
}

export function splitTrackerCapabilities(tracker: TrackerCapabilities): SplitTrackerCapabilities {
  return {
    reader: trackerReaderFrom(tracker),
    schedulerSafetyWriter: schedulerSafetyWriterFrom(tracker),
    agentLifecycleWriter: agentLifecycleWriterFrom(tracker)
  };
}

export function trackerReaderFrom(tracker: TrackerReader): TrackerReader {
  return {
    fetchCandidates: tracker.fetchCandidates.bind(tracker),
    fetchIssueStates: tracker.fetchIssueStates.bind(tracker),
    ...(tracker.fetchTerminalIssues ? { fetchTerminalIssues: tracker.fetchTerminalIssues.bind(tracker) } : {}),
    ...(tracker.fetchIssueComments ? { fetchIssueComments: tracker.fetchIssueComments.bind(tracker) } : {})
  };
}

export function schedulerSafetyWriterFrom(writer: SchedulerSafetyWriter): SchedulerSafetyWriter {
  return trackerLifecycleWriterFrom(writer);
}

export function agentLifecycleWriterFrom(writer: AgentLifecycleWriter): AgentLifecycleWriter {
  return trackerLifecycleWriterFrom(writer);
}

function trackerLifecycleWriterFrom<T extends TrackerLifecycleWriter>(writer: T): T {
  return {
    ...(writer.comment ? { comment: writer.comment.bind(writer) } : {}),
    ...(writer.upsertComment ? { upsertComment: writer.upsertComment.bind(writer) } : {}),
    ...(writer.move ? { move: writer.move.bind(writer) } : {})
  } as T;
}
