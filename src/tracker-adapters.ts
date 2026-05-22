import { LinearClient } from "./linear.js";
import type { IssueTracker, ServiceConfig } from "./types.js";

export type TrackerErrorCategory =
  | "invalid_input"
  | "missing_auth"
  | "transport_error"
  | "rate_limited"
  | "not_found"
  | "permission_denied"
  | "adapter_error";

export class TrackerAdapterError extends Error {
  constructor(
    public readonly category: TrackerErrorCategory,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "TrackerAdapterError";
  }
}

export interface TrackerAdapterDefinition {
  kind: string;
  description: string;
  create(config: ServiceConfig): IssueTracker;
}

const trackerAdapters = new Map<string, TrackerAdapterDefinition>();

registerTrackerAdapter({
  kind: "linear",
  description: "Linear GraphQL tracker adapter",
  create(config) {
    return new LinearClient(config.tracker);
  }
});

export function registerTrackerAdapter(definition: TrackerAdapterDefinition): void {
  const kind = normalizeTrackerKind(definition.kind);
  if (!kind) throw new TrackerAdapterError("invalid_input", "tracker adapter kind is required");
  if (trackerAdapters.has(kind)) throw new TrackerAdapterError("invalid_input", `tracker adapter already registered: ${kind}`);
  trackerAdapters.set(kind, { ...definition, kind });
}

export function unregisterTrackerAdapterForTests(kind: string): void {
  if (normalizeTrackerKind(kind) === "linear") throw new TrackerAdapterError("invalid_input", "cannot unregister built-in linear tracker adapter");
  trackerAdapters.delete(normalizeTrackerKind(kind));
}

export function knownTrackerKinds(): string[] {
  return [...trackerAdapters.keys()].sort();
}

export function trackerAdapterForKind(kind: string): TrackerAdapterDefinition {
  const normalized = normalizeTrackerKind(kind);
  const adapter = trackerAdapters.get(normalized);
  if (!adapter) {
    throw new TrackerAdapterError("invalid_input", `unsupported_tracker_kind: ${kind}; registered adapters: ${knownTrackerKinds().join(", ") || "(none)"}; add a tracker adapter or set tracker.kind: linear`);
  }
  return adapter;
}

export function createIssueTracker(config: ServiceConfig): IssueTracker {
  const tracker = trackerAdapterForKind(config.tracker.kind).create(config);
  assertIssueTracker(tracker, config.tracker.kind);
  return tracker;
}

export function assertIssueTracker(value: unknown, kind = "unknown"): asserts value is IssueTracker {
  const tracker = value as Partial<IssueTracker> | null | undefined;
  for (const method of ["fetchCandidates", "fetchIssueStates"] as const) {
    if (typeof tracker?.[method] !== "function") {
      throw new TrackerAdapterError("adapter_error", `tracker adapter ${kind} is missing required method ${method}`);
    }
  }
}

function normalizeTrackerKind(kind: string): string {
  return kind.trim().toLowerCase();
}
