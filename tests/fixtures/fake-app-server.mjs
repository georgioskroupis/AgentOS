#!/usr/bin/env node
import readline from "node:readline";

if (process.argv.includes("--help")) {
  console.log("fake app-server JSON-RPC");
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
const strictSandbox = process.argv.includes("--strict-sandbox");
const requireGitWritableRoots = process.argv.includes("--require-git-writable-roots");

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } });
  } else if (message.method === "thread/start") {
    if (strictSandbox && message.params?.sandbox !== "workspace-write") {
      write({ id: message.id, error: { message: `bad thread sandbox: ${message.params?.sandbox}` } });
      return;
    }
    write({ id: message.id, result: { thread: { id: "thread-1" } } });
  } else if (message.method === "turn/start") {
    if (strictSandbox && message.params?.sandboxPolicy?.type !== "workspaceWrite") {
      write({ id: message.id, error: { message: `bad turn sandbox: ${message.params?.sandboxPolicy?.type}` } });
      return;
    }
    if (requireGitWritableRoots) {
      const roots = message.params?.sandboxPolicy?.writableRoots ?? [];
      const expectedRoots = [
        process.env.AGENT_OS_EXPECTED_WORKSPACE_ROOT,
        process.env.AGENT_OS_EXPECTED_GIT_DIR,
        process.env.AGENT_OS_EXPECTED_GIT_COMMON_DIR
      ].filter(Boolean);
      const missing = expectedRoots.filter((root) => !roots.includes(root));
      if (missing.length > 0) {
        write({ id: message.id, error: { message: `missing writable roots: ${missing.join(", ")}` } });
        return;
      }
    }
    write({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
    if (process.argv.includes("--approval-request")) {
      write({ method: "approval/requested", params: { turnId: "turn-1", reason: "fixture" } });
      return;
    }
    if (process.argv.includes("--input-request")) {
      write({ method: "turn/input_required", params: { turnId: "turn-1", type: "user_input" } });
      return;
    }
    if (process.argv.includes("--elicitation-request")) {
      write({
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "github",
          mode: "form",
          type: "mcp_elicitation"
        }
      });
      return;
    }
    if (process.argv.includes("--pr-script-failure")) {
      write({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            command: "scripts/agent-create-pr.sh --title Test --body-file pr.md --base main --head agent/AG-1",
            status: "completed",
            exitCode: 1
          }
        }
      });
      return;
    }
    if (process.argv.includes("--nested-orchestrator")) {
      write({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            command: "bin/agent-os orchestrator once --repo . --workflow WORKFLOW.md",
            status: "inProgress"
          }
        }
      });
      return;
    }
    if (process.argv.includes("--nested-orchestrator-shell")) {
      write({
        method: "item/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            command: '/bin/zsh -lc "bin/agent-os orchestrator run --repo . --workflow WORKFLOW.md"',
            status: "inProgress"
          }
        }
      });
      return;
    }
    if (process.argv.includes("--safe-nested-text-search")) {
      write({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            command: 'rg "agent-os orchestrator run" WORKFLOW.md',
            status: "completed",
            exitCode: 0
          }
        }
      });
      write({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" }
        }
      });
      return;
    }
    if (process.argv.includes("--exit-before-completion")) {
      process.exit(42);
    }
    const complete = () => {
      write({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" }
        }
      });
    };
    if (process.argv.includes("--large-stderr")) {
      process.stderr.write("E".repeat(510_000));
    }
    if (process.argv.includes("--long-raw-stdout")) {
      process.stdout.write("R".repeat(20_500));
      setTimeout(() => {
        process.stdout.write("\n");
        complete();
      }, 10);
      return;
    }
    if (process.argv.includes("--ongoing-raw-stdout")) {
      let writes = 0;
      const timer = setInterval(() => {
        writes += 1;
        process.stdout.write("R".repeat(8_500));
        if (writes >= 12) {
          clearInterval(timer);
          process.stdout.write("\n");
          complete();
        }
      }, 100);
      return;
    }
    if (process.argv.includes("--large-json-event-split")) {
      const event = JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            command: "printf large-output",
            status: "completed",
            exitCode: 0,
            output: "O".repeat(12_000)
          }
        }
      });
      process.stdout.write(event.slice(0, 9_000));
      setTimeout(() => {
        process.stdout.write(`${event.slice(9_000)}\n`);
        complete();
      }, 10);
      return;
    }
    if (process.argv.includes("--oversized-json-like-stdout")) {
      const raw = `{${"J".repeat(70_000)}`;
      process.stdout.write(raw.slice(0, 65_000));
      setTimeout(() => {
        process.stdout.write(`${raw.slice(65_000)}\n`);
        complete();
      }, 10);
      return;
    }
    write({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: {
          total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        }
      }
    });
    write({
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 1 }
        }
      }
    });
    if (process.argv.includes("--instant")) complete();
    else setTimeout(complete, 10);
  } else if (message.method === "turn/interrupt") {
    write({ id: message.id, result: {} });
  }
});
