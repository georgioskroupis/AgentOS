export interface RunnerCommandEvidence {
  command: string;
  validationCommand: boolean;
  status: "active" | "completed" | "unknown";
  startedAt: string;
  lastActivityAt: string;
  lastOutputAt?: string;
  outputSeen: boolean;
  exitCode?: number | null;
}

export interface TransportClosureEvidence {
  kind: "app-server-stream-closed";
  reason: string;
  closedAt: string;
  closedDuringActiveCommand: boolean;
  recentValidationOutput: boolean;
  activeCommand?: RunnerCommandEvidence;
  recentCommand?: RunnerCommandEvidence;
}

const RECENT_VALIDATION_OUTPUT_MS = 5 * 60_000;

export class CommandEvidenceTracker {
  private activeCommand: RunnerCommandEvidence | undefined;
  private recentCommand: RunnerCommandEvidence | undefined;

  update(message: Record<string, any>): void {
    const timestamp = new Date().toISOString();
    const item = commandExecutionItem(message);
    if (item?.command) {
      const command = String(item.command);
      const status = commandStatus(item.status, item.exitCode);
      const evidence: RunnerCommandEvidence = {
        command,
        validationCommand: isValidationCommand(command),
        status,
        startedAt: this.activeCommand?.command === command ? this.activeCommand.startedAt : timestamp,
        lastActivityAt: timestamp,
        ...(this.activeCommand?.command === command && this.activeCommand.lastOutputAt ? { lastOutputAt: this.activeCommand.lastOutputAt } : {}),
        outputSeen: Boolean(this.activeCommand?.command === command && this.activeCommand.outputSeen) || Boolean(typeof item.output === "string" && item.output.trim()),
        exitCode: typeof item.exitCode === "number" ? item.exitCode : null
      };
      if (evidence.outputSeen && !evidence.lastOutputAt) evidence.lastOutputAt = timestamp;
      this.recentCommand = evidence;
      this.activeCommand = status === "active" ? evidence : undefined;
      return;
    }
    if (!this.activeCommand || !isCommandOutputMessage(message)) return;
    this.activeCommand = {
      ...this.activeCommand,
      outputSeen: true,
      lastOutputAt: timestamp,
      lastActivityAt: timestamp
    };
    this.recentCommand = this.activeCommand;
  }

  transportClosure(reason: string): TransportClosureEvidence | undefined {
    const command = this.activeCommand ?? this.recentCommand;
    if (!command) return undefined;
    const recentValidationOutput = isRecentValidationOutput(command);
    if (!this.activeCommand && !recentValidationOutput) return undefined;
    return {
      kind: "app-server-stream-closed",
      reason,
      closedAt: new Date().toISOString(),
      closedDuringActiveCommand: Boolean(this.activeCommand),
      recentValidationOutput,
      ...(this.activeCommand ? { activeCommand: this.activeCommand } : {}),
      ...(this.recentCommand ? { recentCommand: this.recentCommand } : {})
    };
  }
}

export function transportClosureMessage(reason: string, evidence: TransportClosureEvidence): string {
  const command = evidence.activeCommand ?? evidence.recentCommand;
  const commandKind = command?.validationCommand ? "validation command" : "child command";
  const activity = evidence.closedDuringActiveCommand ? `${commandKind} was active` : "recent validation output was observed";
  return `codex_app_server_closed: ${reason} while ${activity}; transport stream closed before command result was known`;
}

function commandExecutionItem(message: Record<string, any>): Record<string, any> | null {
  const item = message.params?.item ?? message.item;
  return item?.type === "commandExecution" && typeof item.command === "string" ? item : null;
}

function commandStatus(status: unknown, exitCode: unknown): RunnerCommandEvidence["status"] {
  if (status === "completed" || typeof exitCode === "number") return "completed";
  if (status === "inProgress" || status === "running" || status === "started") return "active";
  return "unknown";
}

function isCommandOutputMessage(message: Record<string, any>): boolean {
  const type = String(message.method ?? message.type ?? "");
  return /commandExecution\/outputDelta|command_output|output_delta/i.test(type);
}

function isValidationCommand(command: string): boolean {
  return /\b(npm\s+run\s+agent-check|npm\s+test|vitest|typecheck|tsc|build|validation|agent-check)\b/i.test(command);
}

function isRecentValidationOutput(command: RunnerCommandEvidence): boolean {
  if (!command.validationCommand || !command.lastOutputAt) return false;
  const lastOutputAt = Date.parse(command.lastOutputAt);
  return Number.isFinite(lastOutputAt) && Date.now() - lastOutputAt <= RECENT_VALIDATION_OUTPUT_MS;
}
