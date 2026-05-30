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

export function formatRegistryRecentEventSummaries(entries: AgentEvent[], limit = 3): string[] {
  const summarized = entries
    .map((entry) => ({ entry, summary: summarizeRunEvent(entry) }))
    .filter(({ summary }) => shouldShowRegistryEventSummary(summary))
    .slice(-limit);
  if (!summarized.length) return [];

  return [
    "  Recent event summaries:",
    ...summarized.map(({ entry, summary }) => `  - ${formatRegistryRecentEvent(entry, summary)}`),
    "  Recent event recovery: raw event payloads are omitted here; inspect the issue or referenced run artifact for details."
  ];
}

function formatRegistryRecentEvent(entry: AgentEvent, summary: ReturnType<typeof summarizeRunEvent>): string {
  const issue = entry.issueIdentifier ? ` ${entry.issueIdentifier}` : "";
  const message = summary.message ? ` - ${summary.message}` : "";
  const details = registryRecentEventDetails(summary);
  return `${summary.timestamp} ${summary.type}${issue}${message}${details ? ` [${details}]` : ""}`;
}

function shouldShowRegistryEventSummary(summary: ReturnType<typeof summarizeRunEvent>): boolean {
  const payloadChars = summary.size.originalPayloadChars ?? summary.size.payloadChars ?? 0;
  return Boolean(summary.artifact || summary.artifactOmittedReason || payloadChars > 8_000);
}

function registryRecentEventDetails(summary: ReturnType<typeof summarizeRunEvent>): string {
  const details: string[] = [];
  if (summary.artifact) details.push(`artifact: ${summary.artifact}`);
  if (summary.artifactOmittedReason) details.push(`artifact omitted: ${summary.artifactOmittedReason}`);
  const payloadChars = summary.size.originalPayloadChars ?? summary.size.payloadChars;
  if (payloadChars != null && payloadChars > 8_000) details.push(`payload: ${payloadChars} char(s)`);
  return details.join("; ");
}
