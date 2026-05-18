import type { ContextBudgetConfig, ContextBudgetState, ContextBudgetTurnKind } from "./types.js";

const TOKEN_CHARS = 4;

export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}

export function evaluateContextBudget(input: {
  config: ContextBudgetConfig;
  kind: ContextBudgetTurnKind;
  prompt: string;
  runId?: string | null;
  previous?: ContextBudgetState | null;
  now?: string;
}): ContextBudgetState {
  const evaluatedAt = input.now ?? new Date().toISOString();
  const estimatedPromptTokens = estimatePromptTokens(input.prompt);
  const previousCumulative = input.previous?.runId && input.runId && input.previous.runId === input.runId ? input.previous.cumulativeEstimatedTokens : 0;
  const cumulativeEstimatedTokens = previousCumulative + estimatedPromptTokens;
  const sections = promptSections(input.prompt).map((section) => {
    const estimatedTokens = estimatePromptTokens(section.text);
    return {
      name: section.name,
      chars: section.text.length,
      estimatedTokens,
      reason: sectionReason(section.name, input.kind),
      large: estimatedTokens >= input.config.largeSectionTokens
    };
  });
  const exceededReasons = input.config.enabled
    ? [
        estimatedPromptTokens > input.config.maxPromptTokens
          ? `estimated prompt size ${estimatedPromptTokens} token(s) exceeds per-turn budget ${input.config.maxPromptTokens}`
          : null,
        cumulativeEstimatedTokens > input.config.maxCumulativeTokens
          ? `cumulative prompt size ${cumulativeEstimatedTokens} token(s) exceeds run budget ${input.config.maxCumulativeTokens}`
          : null
      ].filter((reason): reason is string => Boolean(reason))
    : [];
  const status = exceededReasons.length ? "exceeded" : "within_budget";
  return {
    status,
    evaluatedAt,
    runId: input.runId ?? null,
    kind: input.kind,
    estimatedPromptTokens,
    maxPromptTokens: input.config.maxPromptTokens,
    cumulativeEstimatedTokens,
    maxCumulativeTokens: input.config.maxCumulativeTokens,
    largeSectionTokens: input.config.largeSectionTokens,
    sections,
    ...(exceededReasons.length ? { exceededReasons } : {}),
    summary:
      status === "exceeded"
        ? `Context budget exceeded: ${exceededReasons.join("; ")}.`
        : `Context budget within limits: estimated ${estimatedPromptTokens} token(s), cumulative ${cumulativeEstimatedTokens} token(s).`
  };
}

export function contextBudgetExceededMessage(budget: ContextBudgetState): string {
  return `context_budget_exceeded: ${budget.exceededReasons?.join("; ") ?? budget.summary}`;
}

interface PromptSection {
  name: string;
  text: string;
}

function promptSections(prompt: string): PromptSection[] {
  const sections: PromptSection[] = [];
  let currentName = "Prompt preamble";
  let currentLines: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      sections.push({ name: currentName, text: currentLines.join("\n").trim() });
      currentName = heading[1].trim();
      currentLines = [line];
      continue;
    }
    currentLines.push(line);
  }
  sections.push({ name: currentName, text: currentLines.join("\n").trim() });
  return sections.filter((section) => section.text.length > 0);
}

function sectionReason(name: string, kind: ContextBudgetTurnKind): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("agentos run context")) return "required run identity and validation evidence contract";
  if (normalized.includes("targeted context pack")) return `bounded ${kind} evidence pack from current issue, PR, review, validation, and log state`;
  if (normalized.includes("linear human decision")) return "recent Linear comments and trusted decision evidence needed for re-entry authority";
  if (normalized.includes("existing pr feedback")) return "existing PR feedback is needed to continue review or human-decision re-entry";
  if (normalized.includes("existing implementation audit")) return "prior AgentOS state must be checked before duplicating work";
  if (normalized.includes("continuation")) return "continuation turn context explains the missing handoff requirement";
  if (normalized.includes("automated review")) return "review instructions and artifact contract for the selected reviewer";
  if (normalized.includes("focused fix")) return "fixer instructions and blocking findings for the selected PR";
  return "base workflow prompt or bounded task instructions required for this turn";
}
