import { dirname, join } from "node:path";
import { appendFile, open, readFile } from "node:fs/promises";
import { ensureDir, exists } from "./fs-utils.js";
import { boundEventForJsonl, parseAgentEventsFromJsonl, safeJsonStringify } from "./output-capture.js";
import type { AgentEvent } from "./types.js";

const MAX_TAIL_READ_BYTES = 8 * 1024 * 1024;

export interface AgentOSLogEntry extends AgentEvent {
  runId?: string;
}

export class JsonlLogger {
  readonly logPath: string;

  constructor(private readonly repoRoot: string) {
    this.logPath = join(repoRoot, ".agent-os", "runs", "agent-os.jsonl");
  }

  async write(entry: Omit<AgentOSLogEntry, "timestamp"> & { timestamp?: string }): Promise<AgentOSLogEntry> {
    await ensureDir(dirname(this.logPath));
    const payload: AgentOSLogEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      ...entry
    };
    const bounded = await boundEventForJsonl(payload, {
      repoRoot: this.repoRoot,
      runId: payload.runId
    });
    await appendFile(this.logPath, `${safeJsonStringify(bounded)}\n`, "utf8");
    return bounded;
  }

  async tail(limit = 20): Promise<AgentOSLogEntry[]> {
    if (!(await exists(this.logPath))) return [];
    return parseAgentEventsFromJsonl(await this.tailText()).slice(-limit) as AgentOSLogEntry[];
  }

  private async tailText(): Promise<string> {
    const file = await open(this.logPath, "r");
    try {
      const { size } = await file.stat();
      if (size <= MAX_TAIL_READ_BYTES) return readFile(this.logPath, "utf8");

      const readLength = Math.min(size, MAX_TAIL_READ_BYTES);
      const offset = size - readLength;
      const buffer = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await file.read(buffer, 0, readLength, offset);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) {
        return `${safeJsonStringify({
          type: "event_log_tail_warning",
          message: `event log tail exceeded ${MAX_TAIL_READ_BYTES} byte(s); recent event line omitted`,
          timestamp: "1970-01-01T00:00:00.000Z"
        })}\n`;
      }
      return text.slice(firstNewline + 1);
    } finally {
      await file.close();
    }
  }
}
