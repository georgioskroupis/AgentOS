import type { MonitorStatus, MonitorTimeClass } from "./monitor-contracts.js";

export const monitorSnapshotStatuses = ["idle", "active", "waiting", "human_action", "failed", "completed"] as const;
export type MonitorSnapshotStatus = (typeof monitorSnapshotStatuses)[number];

export const monitorUiSections = ["Run Header", "Tiny Summary", "Current Activity", "Nested Timing Table", "Top Time Sinks", "Human Action", "Links"] as const;
export type MonitorUiSection = (typeof monitorUiSections)[number];

export type MonitorSnapshot = {
  serverNow: string;
  status: MonitorSnapshotStatus;
  run?: {
    issue: { id: string; title: string; url?: string; linearStatus?: string };
    attempt: { current: number; max?: number };
    runElapsedMs: number;
    currentModel?: string;
    links: { linear?: string; pr?: string; handoff?: string; validation?: string };
    summary: { why: string; build: string; done: string };
    currentActivity: {
      stage: string;
      step: string;
      loop?: string;
      iteration?: string;
      stepElapsedMs: number;
      loopElapsedMs?: number;
      lastEventAgeMs: number;
      model?: string;
    };
    timing: TimingRow[];
    topTimeSinks: TimeSink[];
    humanAction: HumanAction;
  };
};

export type TimingRow = {
  id: string;
  label: string;
  status: MonitorStatus;
  timeClass: MonitorTimeClass;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  selfMs: number;
  waitMs: number;
  model?: string;
  iteration?: string;
  result?: string;
  children: TimingRow[];
};

export type TimeSink = {
  id: string;
  label: string;
  selfMs: number;
  timeClass: TimingRow["timeClass"];
  model?: string;
  result?: string;
};

export type HumanAction = {
  required: boolean;
  stoppedBecause: string;
  youShould: string;
  manualTest: string;
  expectedResult: string;
  recommendedNextStep: string;
};

export type LauncherState = {
  status: "stopped" | "starting" | "running" | "stopping" | "failed" | "attached";
  repo: string;
  workflow: string;
  port: number;
  pid?: number;
  url?: string;
  startedAt?: string;
  lastError?: string;
  managedByLauncher: boolean;
};

export type LauncherConfig = {
  repo: string;
  workflow: string;
  port: number;
  host: "127.0.0.1";
  command?: string;
};
