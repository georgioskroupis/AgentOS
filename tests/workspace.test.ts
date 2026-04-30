import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceManager, workspaceKey } from "../src/workspace.js";
import type { ServiceConfig } from "../src/types.js";

describe("workspace", () => {
  it("sanitizes keys", () => {
    expect(workspaceKey("AG 1/hello")).toBe("AG_1_hello");
  });

  it("runs after-create hooks with workspace env", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-os-ws-"));
    const source = await mkdtemp(join(tmpdir(), "agent-os-src-"));
    const config: ServiceConfig = {
      tracker: {
        kind: "linear",
        endpoint: "https://api.linear.app/graphql",
        apiKey: "x",
        projectSlug: "AgentOS",
        activeStates: ["Ready"],
        terminalStates: ["Done"],
        runningState: "In Progress",
        reviewState: "Human Review",
        mergeState: null,
        needsInputState: "Human Review"
      },
      polling: { intervalMs: 1000 },
      workspace: { root },
      hooks: {
        afterCreate: 'mkdir -p "$AGENT_OS_WORKSPACE" && printf "$AGENT_OS_WORKSPACE_KEY" > "$AGENT_OS_WORKSPACE/key.txt"',
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5000
      },
      agent: {
        maxConcurrentAgents: 1,
        maxTurns: 20,
        maxRetryAttempts: 3,
        maxRetryBackoffMs: 1000,
        maxConcurrentAgentsByState: new Map()
      },
      codex: {
        command: "codex app-server",
        turnTimeoutMs: 1000,
        readTimeoutMs: 1000,
        stallTimeoutMs: 1000,
        passThrough: {}
      }
    };

    const manager = new WorkspaceManager(config, source);
    const workspace = await manager.createOrReuse("AG-1");
    expect(await readFile(join(workspace.path, "key.txt"), "utf8")).toBe("AG-1");
  });
});
