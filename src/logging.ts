import { dirname, join } from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import { ensureDir, exists } from "./fs-utils.js";
import { redactValue } from "./redaction.js";
import type { AgentEvent } from "./types.js";

export interface AgentOSLogEntry extends AgentEvent {
  runId?: string;
}

export class JsonlLogger {
  readonly logPath: string;

  constructor(repoRoot: string) {
    this.logPath = join(repoRoot, ".agent-os", "runs", "agent-os.jsonl");
  }

  async write(entry: Omit<AgentOSLogEntry, "timestamp"> & { timestamp?: string }): Promise<AgentOSLogEntry> {
    await ensureDir(dirname(this.logPath));
    const payload: AgentOSLogEntry = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      ...entry
    };
    await appendFile(this.logPath, `${JSON.stringify(redactValue(payload))}\n`, "utf8");
    return payload;
  }

  async tail(limit = 20): Promise<AgentOSLogEntry[]> {
    if (!(await exists(this.logPath))) return [];
    const lines = (await readFile(this.logPath, "utf8")).trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line) as AgentOSLogEntry);
  }
}
