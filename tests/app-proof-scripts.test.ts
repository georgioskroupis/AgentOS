import { spawnSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

describe("app proof scripts", () => {
  it("records configured proof commands without persisting secret-bearing command strings", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-proof-"));
    const result = spawnSync("bash", [resolve("scripts/agent-capture-proof.sh")], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_APP_START_COMMAND: "npm run dev -- --token shh_secret",
        AGENT_HEALTH_CHECK_COMMAND: "echo ok # token=shh_secret",
        AGENT_PROOF_SCREENSHOT_COMMAND: "echo screenshot # token=shh_secret"
      }
    });

    expect(result.status).toBe(0);
    const summary = await readFile(join(repo, ".agent-os", "proof", "latest-proof.md"), "utf8");
    expect(summary).toContain("- Start command: configured");
    expect(summary).toContain("- Health check: configured");
    expect(summary).toContain("- UI screenshot/video proof: configured");
    expect(summary).not.toContain("shh_secret");
    expect(summary).not.toContain("npm run dev");
  });
});
