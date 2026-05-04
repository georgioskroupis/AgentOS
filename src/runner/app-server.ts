import { spawn, spawnSync } from "node:child_process";
import { DEFAULT_CODEX_APP_SERVER_COMMAND } from "../defaults.js";
import type { AgentRunResult, AgentRunner, CodexEventPolicy } from "../types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export async function verifyCodexAppServer(command = DEFAULT_CODEX_APP_SERVER_COMMAND): Promise<{ ok: boolean; details: string }> {
  const output = await captureShell(`${command} --help`, 5_000).catch((error: Error) => error.message);
  const ok = /app server|app-server protocol|json-rpc/i.test(output) && !/Commands:\s+exec\s+Run Codex non-interactively/i.test(output);
  return { ok, details: output.trim() };
}

export class CodexAppServerRunner implements AgentRunner {
  async run(input: Parameters<AgentRunner["run"]>[0]): Promise<AgentRunResult> {
    const support = await verifyCodexAppServer(input.config.codex.command);
    if (!support.ok) {
      return {
        status: "failed",
        error: `codex_app_server_unavailable: command did not expose App Server protocol (${input.config.codex.command})`
      };
    }

    const child = spawn("bash", ["-lc", input.config.codex.command], {
      cwd: input.workspace.path,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const pending = new Map<number, PendingRequest>();
    let id = 1;
    let stdoutBuffer = "";
    let stderr = "";
    let threadId: string | undefined;
    let turnId: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let totalTokens: number | undefined;
    let rateLimits: Array<Record<string, unknown>> = [];
    let turnCompletion: ((message: Record<string, any>) => void) | undefined;
    let turnFailure: ((error: Error) => void) | undefined;
    let bufferedTurnCompletion: Record<string, any> | undefined;
    let bufferedTurnError: Error | undefined;
    let lastEventAt = Date.now();
    let ignoreChildClose = false;
    let turnFinished = false;

    const send = (method: string, params: Record<string, unknown>) => {
      const requestId = id++;
      child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`codex_read_timeout: ${method}`));
        }, input.config.codex.readTimeoutMs);
        pending.set(requestId, { resolve, reject, timer });
      });
    };

    const notify = (method: string, params: Record<string, unknown> = {}) => {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    };

    const failAppServer = (error: Error) => {
      for (const [requestId, request] of pending.entries()) {
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.reject(error);
      }
      if (turnFailure) turnFailure(error);
      else bufferedTurnError = bufferedTurnError ?? error;
    };

    child.on("error", (error) => {
      failAppServer(error);
    });

    child.on("close", (code, signal) => {
      if (ignoreChildClose || turnFinished) return;
      const reason = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      const details = stderr.trim() ? `: ${stderr.trim().slice(-500)}` : "";
      failAppServer(new Error(`codex_app_server_closed: ${reason}${details}`));
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Record<string, any>;
          lastEventAt = Date.now();
          if (typeof message.id === "number" && pending.has(message.id)) {
            const pendingRequest = pending.get(message.id)!;
            clearTimeout(pendingRequest.timer);
            pending.delete(message.id);
            if (message.error) pendingRequest.reject(new Error(JSON.stringify(message.error)));
            else pendingRequest.resolve(message.result);
          } else {
            threadId = message.params?.threadId ?? message.params?.thread?.id ?? message.params?.thread_id ?? message.thread_id ?? threadId;
            turnId = message.params?.turnId ?? message.params?.turn?.id ?? message.params?.turn_id ?? message.turn_id ?? turnId;
            const violation = codexEventPolicyViolation(message, {
              approvalEventPolicy: input.config.codex.approvalEventPolicy,
              userInputPolicy: input.config.codex.userInputPolicy
            });
            if (violation) {
              const error = new Error(violation);
              input.onEvent({
                type: "codex_event_policy_denied",
                issueId: input.issue.id,
                issueIdentifier: input.issue.identifier,
                message: violation,
                payload: {
                  method: message.method ?? message.type,
                  paramType: message.params?.type ?? message.params?.event,
                  policy: violation.includes("approval") ? "approval_event_denied" : "user_input_denied"
                },
                timestamp: new Date().toISOString()
              });
              if (turnFailure) turnFailure(error);
              else bufferedTurnError = error;
              interruptAndTerminate();
              continue;
            }
            const commandStop = codexCommandStop(message);
            if (commandStop) {
              const error = new Error(commandStop.reason);
              input.onEvent({
                type: "codex_command_stop",
                issueId: input.issue.id,
                issueIdentifier: input.issue.identifier,
                message: commandStop.reason,
                payload: {
                  command: commandStop.command,
                  exitCode: commandStop.exitCode
                },
                timestamp: new Date().toISOString()
              });
              if (turnFailure) turnFailure(error);
              else bufferedTurnError = error;
              interruptAndTerminate();
              continue;
            }
            input.onEvent({
              type: String(message.method ?? message.type ?? "codex_event"),
              issueId: input.issue.id,
              issueIdentifier: input.issue.identifier,
              payload: message,
              timestamp: new Date().toISOString()
            });
            const tokens = tokenMetricsFrom(message);
            if (tokens) {
              inputTokens = tokens.input ?? inputTokens;
              outputTokens = tokens.output ?? outputTokens;
              totalTokens = tokens.total ?? totalTokens;
            }
            const rateLimit = rateLimitSnapshotFrom(message);
            if (rateLimit) {
              rateLimits = [...rateLimits, rateLimit].slice(-10);
            }
            if (message.method === "turn/completed" && (!turnId || message.params?.turn?.id === turnId)) {
              turnFinished = true;
              if (turnCompletion) turnCompletion(message);
              else bufferedTurnCompletion = message;
            }
            if (message.method === "error" && (!turnId || message.params?.turnId === turnId)) {
              const error = new Error(message.params?.error?.message ?? "codex_turn_error");
              if (turnFailure) turnFailure(error);
              else bufferedTurnError = error;
            }
          }
        } catch {
          input.onEvent({
            type: "codex_stdout",
            issueId: input.issue.id,
            issueIdentifier: input.issue.identifier,
            message: line,
            timestamp: new Date().toISOString()
          });
        }
      }
    });

    const stallTimer = setInterval(() => {
      if (input.config.codex.stallTimeoutMs > 0 && Date.now() - lastEventAt > input.config.codex.stallTimeoutMs) {
        failAppServer(new Error("codex_stall_timeout"));
        child.kill("SIGTERM");
      }
    }, Math.max(1000, Math.min(input.config.codex.stallTimeoutMs, 30_000)));

    const turnTimer = setTimeout(() => child.kill("SIGTERM"), input.config.codex.turnTimeoutMs);

    try {
      await send("initialize", {
        clientInfo: {
          name: "agent-os",
          title: "AgentOS",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      });
      notify("initialized");
      const thread = (await send("thread/start", {
        cwd: input.workspace.path,
        approvalPolicy: input.config.codex.approvalPolicy ?? "never",
        sandbox: normalizeThreadSandbox(input.config.codex.threadSandbox ?? "workspace-write"),
        experimentalRawEvents: false,
        persistExtendedHistory: true
      })) as Record<string, any>;
      threadId = String(thread.thread?.id ?? thread.threadId ?? thread.id ?? "");
      const turn = (await send("turn/start", {
        threadId,
        input: [{ type: "text", text: input.prompt }],
        cwd: input.workspace.path,
        approvalPolicy: input.config.codex.approvalPolicy ?? "never",
        sandboxPolicy: normalizeSandboxPolicy(input.config.codex.turnSandboxPolicy, input.workspace.path)
      })) as Record<string, any>;
      turnId = String(turn.turn?.id ?? turn.turnId ?? turn.id ?? "");

      const completion = await waitForTurn({
        timeoutMs: input.config.codex.turnTimeoutMs,
        signal: input.signal,
        register(resolve, reject) {
          turnCompletion = resolve;
          turnFailure = reject;
          if (bufferedTurnError) {
            reject(bufferedTurnError);
            bufferedTurnError = undefined;
          } else if (bufferedTurnCompletion) {
            resolve(bufferedTurnCompletion);
            bufferedTurnCompletion = undefined;
          }
        },
        cancel: interruptAndTerminate
      });
      clearInterval(stallTimer);
      clearTimeout(turnTimer);
      ignoreChildClose = true;
      child.kill("SIGTERM");
      const status = completion.params?.turn?.status;
      return {
        status: status === "completed" ? "succeeded" : status === "interrupted" ? "canceled" : "failed",
        threadId,
        turnId,
        inputTokens,
        outputTokens,
        totalTokens,
        rateLimits,
        error: completion.params?.turn?.error?.message
      };
    } catch (error) {
      clearInterval(stallTimer);
      clearTimeout(turnTimer);
      ignoreChildClose = true;
      child.kill("SIGTERM");
      return {
        status: runnerStatusForError(error),
        threadId,
        turnId,
        inputTokens,
        outputTokens,
        totalTokens,
        rateLimits,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("codex_app_server_closed"));
      }
      if (stderr.trim()) {
        input.onEvent({
          type: "codex_stderr",
          issueId: input.issue.id,
          issueIdentifier: input.issue.identifier,
          message: stderr.trim().slice(-2000),
          timestamp: new Date().toISOString()
        });
      }
    }

    function interruptAndTerminate() {
      if (threadId && turnId) {
        void send("turn/interrupt", { threadId, turnId }).catch(() => undefined);
      }
      ignoreChildClose = true;
      child.kill("SIGTERM");
    }
  }
}

function runnerStatusForError(error: unknown): AgentRunResult["status"] {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("codex_stall_timeout")) return "stalled";
  if (message.includes("codex_turn_timeout") || message.includes("codex_read_timeout")) return "timed_out";
  if (message.includes("canceled")) return "canceled";
  return "failed";
}

function tokenMetricsFrom(message: Record<string, any>): { input?: number; output?: number; total?: number } | null {
  const usage = message.params?.tokenUsage?.total ?? message.params?.tokenUsage ?? message.params?.usage ?? null;
  if (!usage || typeof usage !== "object") return null;
  const input = numberValue(usage.inputTokens ?? usage.input_tokens ?? usage.input);
  const output = numberValue(usage.outputTokens ?? usage.output_tokens ?? usage.output);
  const total = numberValue(usage.totalTokens ?? usage.total_tokens ?? usage.total);
  if (input == null && output == null && total == null) return null;
  return { input, output, total };
}

function rateLimitSnapshotFrom(message: Record<string, any>): Record<string, unknown> | null {
  const snapshot = message.params?.rateLimits ?? message.params?.rateLimit ?? null;
  return snapshot && typeof snapshot === "object" ? snapshot : null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeThreadSandbox(value: unknown): unknown {
  if (value === "workspaceWrite") return "workspace-write";
  if (value === "readOnly") return "read-only";
  if (value === "dangerFullAccess") return "danger-full-access";
  return value;
}

function normalizeTurnSandbox(value: unknown): unknown {
  if (value === "workspace-write") return "workspaceWrite";
  if (value === "read-only") return "readOnly";
  if (value === "danger-full-access") return "dangerFullAccess";
  return value;
}

function normalizeSandboxPolicy(policy: unknown, workspacePath: string): unknown {
  if (policy && typeof policy === "object" && !Array.isArray(policy)) {
    const normalized = { ...(policy as Record<string, unknown>) };
    normalized.type = normalizeTurnSandbox(normalized.type);
    if (normalized.type === "workspaceWrite" && !Array.isArray(normalized.writableRoots)) {
      normalized.writableRoots = workspaceWritableRoots(workspacePath);
    }
    if (typeof normalized.networkAccess !== "boolean") {
      normalized.networkAccess = false;
    }
    return normalized;
  }
  return {
    type: "workspaceWrite",
    writableRoots: workspaceWritableRoots(workspacePath),
    networkAccess: false
  };
}

function workspaceWritableRoots(workspacePath: string): string[] {
  return uniquePaths([workspacePath, ...gitMetadataWritableRoots(workspacePath)]);
}

function gitMetadataWritableRoots(workspacePath: string): string[] {
  const result = spawnSync("git", ["-C", workspacePath, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], {
    encoding: "utf8"
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function codexEventPolicyViolation(
  message: Record<string, any>,
  policy: { approvalEventPolicy: CodexEventPolicy; userInputPolicy: CodexEventPolicy }
): string | null {
  const eventName = String(message.method ?? message.type ?? "").toLowerCase();
  const paramType = String(message.params?.type ?? message.params?.event ?? "").toLowerCase();
  const combined = `${eventName} ${paramType}`;

  const isRequest = /request|requested|required|needed/.test(combined);
  if (combined.includes("approval") && isRequest && policy.approvalEventPolicy === "deny") {
    return "codex_approval_request_denied";
  }
  if (combined.includes("elicitation") && isRequest && policy.userInputPolicy === "deny") {
    return "codex_elicitation_request_denied";
  }
  if ((combined.includes("input") || combined.includes("user-input") || combined.includes("confirmation") || combined.includes("confirm")) && isRequest && policy.userInputPolicy === "deny") {
    return "codex_user_input_request_denied";
  }
  return null;
}

function codexCommandStop(message: Record<string, any>): { reason: string; command: string; exitCode: number | null } | null {
  if (message.method !== "item/started" && message.method !== "item/completed") return null;
  const item = message.params?.item;
  if (!item || item.type !== "commandExecution") return null;
  const command = String(item.command ?? "");
  if (/\b(?:bin\/)?agent-os\s+orchestrator\s+(?:once|run)\b/.test(command)) {
    return { reason: "nested_orchestrator_forbidden", command, exitCode: null };
  }
  const status = String(item.status ?? "");
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
  if (!["completed", "failed"].includes(status) || exitCode === 0) return null;
  if (/\b(agent-create-pr\.sh|gh\s+pr\s+create)\b/.test(command)) {
    return { reason: "agent_pr_creation_failed", command, exitCode };
  }
  return null;
}

function captureShell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command_timeout: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
    child.stderr.on("data", (chunk) => (out += chunk.toString()));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForTurn(options: {
  timeoutMs: number;
  signal?: AbortSignal;
  register: (resolve: (message: Record<string, any>) => void, reject: (error: Error) => void) => void;
  cancel: () => void;
}): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      options.cancel();
      reject(new Error("codex_turn_timeout"));
    }, options.timeoutMs);
    const abort = () => {
      clearTimeout(timer);
      options.cancel();
      reject(new Error("canceled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    options.register(
      (message) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        resolve(message);
      },
      (error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
