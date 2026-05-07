import type { RunTimingPhase } from "./runs.js";
import type { Issue, IssueState } from "./types.js";

const TERMINAL_WAIT_PHASES: RunTimingPhase[] = ["human-wait", "needs-input", "ci-wait"];

export interface TerminalWaitPhaseFinish {
  runId: string;
  phase: RunTimingPhase;
  metadata: Record<string, unknown>;
}

export function terminalWaitPhaseFinishes(issue: Issue, state: IssueState | null, reason: string): TerminalWaitPhaseFinish[] {
  const runId = state?.lastRunId;
  if (!runId) return [];
  return TERMINAL_WAIT_PHASES.map((phase) => ({
    runId,
    phase,
    metadata: { reason, terminalState: issue.state }
  }));
}
