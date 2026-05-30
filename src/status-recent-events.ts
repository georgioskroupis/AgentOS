import { summarizeRunEvent } from "./run-event-summary.js";
import { recentEventMessage } from "./status-diagnostics.js";
import type { AgentEvent } from "./types.js";

export function formatInspectRecentEvent(entry: AgentEvent): string {
  const summary = summarizeRunEvent(entry);
  const safeMessage = recentEventMessage(entry);
  const message =
    safeMessage === (entry.message ?? "")
      ? summary.message
      : summarizeRunEvent({ ...entry, message: safeMessage }).message;
  const details = inspectRecentEventDetails(summary);
  return `${summary.timestamp} ${summary.type}${message ? ` - ${message}` : ""}${details ? ` [${details}]` : ""}`;
}

function inspectRecentEventDetails(summary: ReturnType<typeof summarizeRunEvent>): string {
  const details: string[] = [];
  if (summary.artifact) details.push(`artifact: ${summary.artifact}`);
  if (summary.artifactOmittedReason) details.push(`artifact omitted: ${summary.artifactOmittedReason}`);
  const payloadChars = summary.size.originalPayloadChars ?? summary.size.payloadChars;
  if (payloadChars != null && payloadChars > 8_000 && !summary.artifact) details.push(`payload: ${payloadChars} char(s)`);
  return details.join("; ");
}
