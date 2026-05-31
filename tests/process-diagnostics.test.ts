import { describe, expect, it } from "vitest";
import { compactProcessDiagnostic, compactProcessListDiagnostic } from "../src/process-diagnostics.js";

describe("process diagnostics", () => {
  it("summarizes process lists without prompt text or AgentOS artifact paths", () => {
    const workspacePrefix = "/Users/example/Active Projects/AgentOS/.agent-os/workspaces/VER-198";
    const stalePrompt = "Active scope: prevent diagnostic process checks from leaking prompt-sized command output. ".repeat(30);
    const list = [
      "  PID STAT COMMAND",
      `12345 S+ bash -lc "cat ${workspacePrefix}/.agent-os/runs/run_old/prompt.md && ${stalePrompt}"`,
      `12346 R+ node ${workspacePrefix}/.agent-os/runs/run_old/prompt.md --raw-log "${stalePrompt}"`,
      "12347 S+ npm run agent-check"
    ].join("\n");

    const diagnostics = compactProcessListDiagnostic(list);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics).toEqual([
      { pid: 12345, status: "S+", commandName: "bash" },
      { pid: 12346, status: "R+", commandName: "node" },
      { pid: 12347, status: "S+", commandName: "npm" }
    ]);
    expect(serialized.length).toBeLessThan(300);
    expect(serialized).not.toContain(stalePrompt.slice(0, 40));
    expect(serialized).not.toContain(".agent-os/runs");
    expect(serialized).not.toContain("prompt.md");
    expect(serialized).not.toContain(workspacePrefix);
  });

  it("keeps recovery validation process diagnostics to PID status and command name", () => {
    const diagnostic = compactProcessDiagnostic({
      pid: 24680,
      status: "running",
      command: "LINEAR_API_KEY=secret-value bash -lc 'npm run agent-check -- --prompt .agent-os/runs/run_old/prompt.md'"
    });
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toEqual({ pid: 24680, status: "running", commandName: "bash" });
    expect(serialized).not.toContain("LINEAR_API_KEY");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain(".agent-os/runs");
    expect(serialized).not.toContain("prompt.md");
    expect(serialized.length).toBeLessThan(80);
  });
});
