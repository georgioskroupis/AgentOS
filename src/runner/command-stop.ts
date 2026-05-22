export function codexCommandStop(message: Record<string, any>): { reason: string; command: string; exitCode: number | null } | null {
  if (message.method !== "item/started" && message.method !== "item/completed") return null;
  const item = message.params?.item;
  if (!item || item.type !== "commandExecution") return null;
  const command = String(item.command ?? "");
  if (executesNestedOrchestrator(command)) return { reason: "nested_orchestrator_forbidden", command, exitCode: null };
  const status = String(item.status ?? "");
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  if (!["completed", "failed"].includes(status) || exitCode === 0) return null;
  return /\b(agent-create-pr\.sh|gh\s+pr\s+create)\b/.test(command) ? { reason: "agent_pr_creation_failed", command, exitCode } : null;
}

function executesNestedOrchestrator(command: string): boolean {
  return splitCommandSegments(command).some((segment) => segmentExecutesNestedOrchestrator(segment));
}

function segmentExecutesNestedOrchestrator(segment: string): boolean {
  const words = shellWords(segment);
  if (words.length === 0) return false;
  const first = basename(words[0]);
  if (first === "env" || first === "command") return segmentExecutesNestedOrchestrator(words.slice(1).join(" "));
  if (first === "npx") return segmentExecutesNestedOrchestrator(words.slice(1).filter((word) => !word.startsWith("-")).join(" "));
  const shellScript = shellCommandArgument(first, words);
  if (shellScript) return executesNestedOrchestrator(shellScript);
  const offset = first === "node" && basename(words[1] ?? "") === "agent-os" ? 1 : 0;
  const executable = basename(words[offset]);
  return executable === "agent-os" && words[offset + 1] === "orchestrator" && (words[offset + 2] === "once" || words[offset + 2] === "run");
}

function shellCommandArgument(first: string, words: string[]): string | null {
  if (first !== "bash" && first !== "sh" && first !== "zsh") return null;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--") break;
    if (word === "-c" || (/^-[A-Za-z]+$/.test(word) && word.includes("c"))) return words[index + 1] ?? null;
  }
  return null;
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (!quote && (char === ";" || char === "\n" || ((char === "&" || char === "|") && command[index + 1] === char))) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if (char !== ";" && char !== "\n") index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words.filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word));
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
