import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeTextEnsuringDir } from "./fs-utils.js";
import { redactText, redactValue } from "./redaction.js";
import type { AgentEvent } from "./types.js";

const INLINE_TEXT_LIMIT = 2_000;
const INLINE_PAYLOAD_JSON_LIMIT = 8_000;
const INLINE_EVENT_JSON_LIMIT = 12_000;
const ARTIFACT_TEXT_LIMIT = 500_000;
const INLINE_ARRAY_LIMIT = 50;
const INLINE_OBJECT_KEY_LIMIT = 50;
const INLINE_DEPTH_LIMIT = 8;

interface CaptureContext {
  repoRoot: string;
  runId?: string | null;
}

export interface TextSummary {
  inline: string;
  originalChars: number;
  truncated: boolean;
  binaryLike: boolean;
  duplicateLines: number;
}

export class BoundedTextAccumulator {
  private head = "";
  private tail = "";
  private totalChars = 0;

  constructor(
    private readonly headLimit = ARTIFACT_TEXT_LIMIT,
    private readonly tailLimit = INLINE_TEXT_LIMIT
  ) {}

  append(chunk: unknown): void {
    const text = chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    this.totalChars += text.length;
    if (this.head.length < this.headLimit) {
      this.head += text.slice(0, this.headLimit - this.head.length);
    }
    this.tail = `${this.tail}${text}`.slice(-this.tailLimit);
  }

  text(): string {
    if (this.totalChars <= this.head.length) return this.head;
    let headLength = this.head.length;
    let tailLength = this.tail.length;
    let banner = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const availableForText = Math.max(0, this.headLimit - banner.length);
      tailLength = Math.min(this.tail.length, availableForText);
      headLength = Math.min(this.head.length, Math.max(0, availableForText - tailLength));
      const omitted = Math.max(0, this.totalChars - headLength - tailLength);
      const nextBanner = `\n[AgentOS capture omitted ${omitted} character(s) beyond the safe artifact limit]\n`;
      if (nextBanner.length === banner.length) {
        banner = nextBanner;
        break;
      }
      banner = nextBanner;
    }
    const text = `${this.head.slice(0, headLength)}${banner}${this.tail.slice(-tailLength)}`;
    return text.length <= this.headLimit ? text : text.slice(0, this.headLimit);
  }

  tailText(limit = INLINE_TEXT_LIMIT): string {
    return this.tail.slice(-limit);
  }

  get length(): number {
    return this.totalChars;
  }
}

export async function boundEventForJsonl<T extends AgentEvent & { runId?: string }>(entry: T, context: CaptureContext): Promise<T> {
  const runId = context.runId ?? entry.runId ?? null;
  const redacted = redactValue(entry) as AgentEvent & { runId?: string };
  const event: AgentEvent & { runId?: string } = { ...redacted };

  if (typeof event.message === "string") {
    event.message = await inlineTextWithArtifact(event.message, context.repoRoot, runId, event, "message");
  }

  if (event.payload !== undefined) {
    const payloadJson = safeJsonStringify(event.payload, 2);
    if (payloadJson.length > INLINE_PAYLOAD_JSON_LIMIT) {
      const artifact = await writeArtifactIfSafe(context.repoRoot, runId, event, "payload", "json", payloadJson);
      event.payload = {
        agentOsCapture: {
          kind: "payload",
          summary: "large event payload captured outside JSONL",
          originalChars: payloadJson.length,
          artifact: artifact ?? undefined,
          artifactOmittedReason: artifact ? undefined : "payload was too large or binary-like"
        }
      };
    } else {
      event.payload = normalizeInlineValue(event.payload, 0);
    }
  }

  const line = safeJsonStringify(event);
  if (line.length <= INLINE_EVENT_JSON_LIMIT) return event as T;

  const eventJson = safeJsonStringify(redacted, 2);
  const artifact = await writeArtifactIfSafe(context.repoRoot, runId, event, "event", "json", eventJson);
  const bounded: AgentEvent & { runId?: string } = {
    type: event.type,
    issueId: event.issueId,
    issueIdentifier: event.issueIdentifier,
    timestamp: event.timestamp,
    runId: event.runId,
    message: event.message ? summarizeText(event.message).inline : "large event captured outside JSONL",
    payload: {
      agentOsCapture: {
        kind: "event",
        summary: "large event captured outside JSONL",
        originalChars: eventJson.length,
        artifact: artifact ?? undefined,
        artifactOmittedReason: artifact ? undefined : "event was too large or binary-like"
      }
    }
  };
  return bounded as T;
}

export function safeJsonStringify(value: unknown, space?: number): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "bigint") return `${item.toString()}n`;
        if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
        if (typeof item === "symbol") return String(item);
        if (item && typeof item === "object") {
          if (seen.has(item)) return "[Circular]";
          seen.add(item);
        }
        return item;
      },
      space
    ) ?? "null"
  );
}

export function parseAgentEventsFromJsonl(text: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  const lines = text.trim().split("\n").filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    try {
      events.push(JSON.parse(lines[index]) as AgentEvent);
    } catch {
      events.push({
        type: "event_log_parse_warning",
        message: `skipped malformed JSONL line ${index + 1}`,
        timestamp: "1970-01-01T00:00:00.000Z"
      });
    }
  }
  return events;
}

export function summarizeText(value: string, limit = INLINE_TEXT_LIMIT): TextSummary {
  const redacted = redactText(value);
  const binaryLike = isBinaryLike(redacted);
  if (binaryLike) {
    return {
      inline: `[binary-like output omitted; ${redacted.length} character(s) after redaction]`,
      originalChars: redacted.length,
      truncated: true,
      binaryLike,
      duplicateLines: 0
    };
  }

  const deduped = dedupeRepeatedLines(redacted);
  const truncated = deduped.text.length > limit;
  const inline = truncated
    ? `${deduped.text.slice(0, limit).trimEnd()}\n[output truncated; ${redacted.length} original character(s)]`
    : deduped.text;
  return {
    inline,
    originalChars: redacted.length,
    truncated,
    binaryLike,
    duplicateLines: deduped.duplicateLines
  };
}

async function inlineTextWithArtifact(
  value: string,
  repoRoot: string,
  runId: string | null,
  event: Pick<AgentEvent, "type" | "timestamp">,
  field: string
): Promise<string> {
  const redacted = redactText(value);
  const summary = summarizeText(redacted);
  if (!summary.truncated && summary.duplicateLines === 0) return summary.inline;
  const artifact = await writeArtifactIfSafe(repoRoot, runId, event, field, "txt", redacted);
  if (!artifact) return summary.inline;
  return `${summary.inline}\n[full redacted artifact: ${artifact}]`;
}

async function writeArtifactIfSafe(
  repoRoot: string,
  runId: string | null,
  event: Pick<AgentEvent, "type" | "timestamp">,
  field: string,
  extension: "json" | "txt",
  content: string
): Promise<string | null> {
  if (!content.trim()) return null;
  if (isBinaryLike(content)) return null;
  if (content.length > ARTIFACT_TEXT_LIMIT) return null;
  const relativePath = artifactRelativePath(runId, event, field, extension, content);
  await writeTextEnsuringDir(join(repoRoot, relativePath), content.endsWith("\n") ? content : `${content}\n`);
  return relativePath;
}

function normalizeInlineValue(value: unknown, depth: number, seen = new WeakSet<object>()): unknown {
  if (depth > INLINE_DEPTH_LIMIT) return "[Max inline depth reached]";
  if (value == null) return value;
  if (typeof value === "string") return summarizeText(value).inline;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: summarizeText(value.message).inline
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const items = value.slice(0, INLINE_ARRAY_LIMIT).map((item) => normalizeInlineValue(item, depth + 1, seen));
    if (value.length > INLINE_ARRAY_LIMIT) items.push(`[${value.length - INLINE_ARRAY_LIMIT} item(s) omitted]`);
    return items;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, INLINE_OBJECT_KEY_LIMIT)) {
      out[key] = normalizeInlineValue(item, depth + 1, seen);
    }
    if (entries.length > INLINE_OBJECT_KEY_LIMIT) out.agentOsOmittedKeys = entries.length - INLINE_OBJECT_KEY_LIMIT;
    return out;
  }
  return String(value);
}

function dedupeRepeatedLines(value: string): { text: string; duplicateLines: number } {
  const lines = value.split(/\r?\n/);
  if (lines.length < 4) return { text: value, duplicateLines: 0 };

  const counts = new Map<string, { line: string; count: number }>();
  for (const line of lines) {
    const key = line.trim();
    if (!key) continue;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { line, count: 1 });
  }

  const repeated = [...counts.values()].filter((entry) => entry.count > 1);
  if (repeated.length === 0) return { text: value, duplicateLines: 0 };

  const summarized = [...counts.values()].slice(0, 12).map((entry) => (entry.count > 1 ? `${entry.line} (repeated ${entry.count}x)` : entry.line));
  if (counts.size > summarized.length) summarized.push(`[${counts.size - summarized.length} unique line(s) omitted]`);
  const duplicateLines = repeated.reduce((total, entry) => total + entry.count - 1, 0);
  summarized.push(`[${duplicateLines} duplicate line(s) summarized]`);
  return { text: summarized.join("\n"), duplicateLines };
}

function isBinaryLike(value: string): boolean {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F]/.test(value)) return true;
  const replacements = value.match(/\uFFFD/g)?.length ?? 0;
  return value.length > 0 && replacements / value.length > 0.02;
}

function artifactRelativePath(
  runId: string | null,
  event: Pick<AgentEvent, "type" | "timestamp">,
  field: string,
  extension: "json" | "txt",
  content: string
): string {
  const root = runId ? `.agent-os/runs/${safeSegment(runId)}/artifacts` : ".agent-os/runs/artifacts";
  const stamp = safeSegment((event.timestamp || new Date().toISOString()).replace(/[-:.TZ]/g, "").slice(0, 14));
  const type = safeSegment(event.type || "event");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `${root}/${stamp}-${type}-${safeSegment(field)}-${hash}.${extension}`;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "event";
}
