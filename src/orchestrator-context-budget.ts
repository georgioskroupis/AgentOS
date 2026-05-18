import { IssueStateStore } from "./issue-state.js";
import type { JsonlLogger } from "./logging.js";
import { evaluateContextBudget } from "./context-budget.js";
import type { AgentEvent, ContextBudgetConfig, ContextBudgetState, ContextBudgetTurnKind, Issue, IssueState } from "./types.js";

export async function recordContextBudgetForIssue(input: {
  repoRoot: string;
  config: ContextBudgetConfig;
  issue: Issue;
  runId?: string | null;
  kind: ContextBudgetTurnKind;
  prompt: string;
  logger: JsonlLogger;
  recordIssueState: (issue: Issue, patch: Partial<IssueState>) => Promise<IssueState>;
  writeRunEvent: (runId: string, entry: Omit<AgentEvent, "timestamp"> & { timestamp?: string; runId?: string }) => Promise<void>;
}): Promise<ContextBudgetState> {
  const state = await new IssueStateStore(input.repoRoot).read(input.issue.identifier).catch(() => null);
  const budget = evaluateContextBudget({
    config: input.config,
    kind: input.kind,
    prompt: input.prompt,
    runId: input.runId,
    previous: state?.contextBudget ?? null
  });
  await input.recordIssueState(input.issue, { contextBudget: budget });
  await input.logger.write({
    type: "context_budget",
    issueId: input.issue.id,
    issueIdentifier: input.issue.identifier,
    message: budget.summary,
    payload: budget
  });
  if (input.runId) {
    await input.writeRunEvent(input.runId, {
      type: "context_budget",
      issueId: input.issue.id,
      issueIdentifier: input.issue.identifier,
      message: budget.summary,
      payload: budget
    });
  }
  return budget;
}
