import { dirname, join } from "node:path";
import { appendFile, readFile } from "node:fs/promises";
import { ensureDir, exists } from "./fs-utils.js";
import { boundEventForJsonl, parseAgentEventsFromJsonl, safeJsonStringify } from "./output-capture.js";
import type { AgentEvent } from "./types.js";

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
    return parseAgentEventsFromJsonl(await readFile(this.logPath, "utf8")).slice(-limit) as AgentOSLogEntry[];
  }
}
