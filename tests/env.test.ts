import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRepoEnv, resolveRepoEnv } from "../src/env.js";

describe("repo-local daemon env loading", () => {
  it("reports a missing .agent-os/env file without failing local env resolution", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-env-missing-"));

    const result = await resolveRepoEnv(repo, { LINEAR_API_KEY: "lin_shell" });

    expect(result.repoEnv.status).toBe("missing");
    expect(result.env.LINEAR_API_KEY).toBe("lin_shell");
  });

  it("reports malformed env files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-env-malformed-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "env"), "LINEAR_API_KEY lin_missing_equals\n", "utf8");

    const result = await loadRepoEnv(repo);

    expect(result.status).toBe("malformed");
    expect(result.errors[0]).toContain("expected KEY=VALUE");
  });

  it("reports stale placeholder Linear credentials", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-env-stale-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "env"), "LINEAR_API_KEY=CHANGE_ME\n", "utf8");

    const result = await loadRepoEnv(repo);

    expect(result.status).toBe("stale");
    expect(result.loadedKeys).toEqual(["LINEAR_API_KEY"]);
  });

  it("loads valid repo env values over the process environment", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-env-loaded-"));
    await mkdir(join(repo, ".agent-os"), { recursive: true });
    await writeFile(join(repo, ".agent-os", "env"), "LINEAR_API_KEY=lin_file\nAGENT_OS_SOURCE_REPO=/tmp/agent-os\n", "utf8");

    const result = await resolveRepoEnv(repo, { LINEAR_API_KEY: "lin_shell" });

    expect(result.repoEnv.status).toBe("loaded");
    expect(result.env.LINEAR_API_KEY).toBe("lin_file");
    expect(result.env.AGENT_OS_SOURCE_REPO).toBe("/tmp/agent-os");
  });
});
