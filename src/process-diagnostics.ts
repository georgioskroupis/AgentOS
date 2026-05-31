import { basename } from "node:path";
import { redactText } from "./redaction.js";

const MAX_PROCESS_ROWS = 20;
const MAX_COMMAND_NAME = 80;
const MAX_STATUS = 32;

export interface CompactProcessDiagnosticInput {
  pid?: number | string | null;
  status?: string | null;
  command?: string | null;
}

export interface CompactProcessDiagnostic {
  pid?: number;
  status?: string;
  commandName: string;
}

export function compactProcessDiagnostic(input: CompactProcessDiagnosticInput): CompactProcessDiagnostic {
  return {
    ...(parsePid(input.pid) != null ? { pid: parsePid(input.pid)! } : {}),
    ...(compactStatus(input.status) ? { status: compactStatus(input.status)! } : {}),
    commandName: compactCommandName(input.command)
  };
}

export function compactProcessListDiagnostic(processList: string): CompactProcessDiagnostic[] {
  const diagnostics: CompactProcessDiagnostic[] = [];
  for (const line of processList.split(/\r?\n/)) {
    const parsed = parseProcessListLine(line);
    if (!parsed) continue;
    diagnostics.push(compactProcessDiagnostic(parsed));
    if (diagnostics.length >= MAX_PROCESS_ROWS) break;
  }
  return diagnostics;
}

function parseProcessListLine(line: string): CompactProcessDiagnosticInput | null {
  const trimmed = line.trim();
  if (!trimmed || /^pid\s+/i.test(trimmed)) return null;

  const pidStatusCommand = trimmed.match(/^(\d+)\s+([A-Za-z?+<NIRSDTZWXslPs0-9-]+)\s+(.+)$/);
  if (pidStatusCommand) {
    return { pid: pidStatusCommand[1], status: pidStatusCommand[2], command: pidStatusCommand[3] };
  }

  const pidCommand = trimmed.match(/^(\d+)\s+(.+)$/);
  if (pidCommand) return { pid: pidCommand[1], command: pidCommand[2] };

  return { command: trimmed };
}

function parsePid(value: CompactProcessDiagnosticInput["pid"]): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function compactStatus(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.trim().replace(/[^A-Za-z0-9_+?.-]/g, "").slice(0, MAX_STATUS);
  return compact || undefined;
}

function compactCommandName(command: string | null | undefined): string {
  if (typeof command !== "string") return "unknown";
  const token = firstCommandToken(redactText(command).replace(/\0/g, " "));
  if (!token) return "unknown";
  const cleaned = basename(token.replace(/^['"]|['"]$/g, "")).replace(/[^A-Za-z0-9_.@+-]/g, "");
  return cleaned.slice(0, MAX_COMMAND_NAME) || "unknown";
}

function firstCommandToken(command: string): string | null {
  const tokens = command.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  for (const token of tokens) {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    if (!unquoted || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(unquoted)) continue;
    if (unquoted === "env" || unquoted.endsWith("/env")) continue;
    return unquoted;
  }
  return null;
}
