import { summarizeText } from "./output-capture.js";
import type { AgentEvent } from "./types.js";

export interface RunEventSummary {
  type: string;
  timestamp: string;
  message?: string;
  artifact?: string;
  artifactOmittedReason?: string;
  size: {
    messageChars?: number;
    payloadChars?: number;
    originalPayloadChars?: number;
    eventApproxChars: number;
  };
}

export function summarizeRunEvent(event: AgentEvent): RunEventSummary {
  const messageSummary = typeof event.message === "string" ? summarizeText(event.message) : null;
  const capture = eventCaptureMetadata(event.payload);
  const payloadSize = measurePayloadChars(event.payload);
  const messageChars = typeof event.message === "string" ? event.message.length : undefined;
  const originalPayloadChars = capture?.originalChars ?? payloadSize;
  const artifact = capture?.artifact ?? messageArtifactReference(event.message);
  return {
    type: summarizeText(event.type, 500).inline,
    timestamp: summarizeText(event.timestamp, 500).inline,
    ...(messageSummary ? { message: messageSummary.inline } : {}),
    ...(artifact ? { artifact } : {}),
    ...(capture?.artifactOmittedReason ? { artifactOmittedReason: capture.artifactOmittedReason } : {}),
    size: {
      ...(messageChars != null ? { messageChars } : {}),
      ...(payloadSize != null ? { payloadChars: payloadSize } : {}),
      ...(originalPayloadChars != null ? { originalPayloadChars } : {}),
      eventApproxChars: eventApproxChars(event, messageChars, payloadSize)
    }
  };
}

export function summarizeRunEvents(events: AgentEvent[]): RunEventSummary[] {
  return events.map((event) => summarizeRunEvent(event));
}

function eventCaptureMetadata(payload: unknown): { artifact?: string; artifactOmittedReason?: string; originalChars?: number } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const capture = (payload as { agentOsCapture?: unknown }).agentOsCapture;
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) return null;
  const record = capture as Record<string, unknown>;
  return {
    ...(typeof record.artifact === "string" ? { artifact: record.artifact } : {}),
    ...(typeof record.artifactOmittedReason === "string" ? { artifactOmittedReason: record.artifactOmittedReason } : {}),
    ...(typeof record.originalChars === "number" && Number.isFinite(record.originalChars) ? { originalChars: Math.max(0, Math.floor(record.originalChars)) } : {})
  };
}

function messageArtifactReference(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  return message.match(/\[full redacted artifact:\s+([^\]\r\n]+)\]/)?.[1]?.trim();
}

function eventApproxChars(event: AgentEvent, messageChars: number | undefined, payloadChars: number | undefined): number {
  return (
    event.type.length +
    event.timestamp.length +
    (event.issueId?.length ?? 0) +
    (event.issueIdentifier?.length ?? 0) +
    (messageChars ?? 0) +
    (payloadChars ?? 0)
  );
}

function measurePayloadChars(value: unknown, depth = 0, seen = new WeakSet<object>()): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value).length;
  if (typeof value === "function" || typeof value === "symbol") return String(value).length;
  if (depth > 8) return 0;
  if (typeof value !== "object") return String(value).length;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + (measurePayloadChars(item, depth + 1, seen) ?? 0), 0);
  }
  return Object.entries(value as Record<string, unknown>).reduce(
    (total, [key, item]) => total + key.length + (measurePayloadChars(item, depth + 1, seen) ?? 0),
    0
  );
}
