import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentOsHttpServer, type AgentOsHttpServerHandle } from "../src/http-server.js";

const handles: AgentOsHttpServerHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("AgentOS monitor placeholder", () => {
  it("is disabled without an explicit port", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-disabled-"));
    await expect(startAgentOsHttpServer({ repoRoot: repo })).resolves.toBeNull();
  });

  it("serves only the static dashboard route", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-placeholder-"));
    const server = await startAgentOsHttpServer({ repoRoot: repo, port: 0 });
    expect(server).not.toBeNull();
    handles.push(server!);

    const root = await fetch(`${server!.url}/`);
    expect(root.status).toBe(200);
    await expect(root.text()).resolves.toContain("AgentOS Monitor");

    const method = await fetch(`${server!.url}/`, { method: "POST" });
    expect(method.status).toBe(405);
    await expect(method.json()).resolves.toMatchObject({ success: false, error: { code: "method_not_allowed" } });
  });

  it("does not expose legacy monitor API routes", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-http-no-legacy-"));
    const server = await startAgentOsHttpServer({ repoRoot: repo, port: 0 });
    expect(server).not.toBeNull();
    handles.push(server!);
    const oldApiRoot = ["", "api", "v1"].join("/");

    for (const [path, init] of [
      [`${oldApiRoot}/state`, undefined],
      [`${oldApiRoot}/VER-96`, undefined],
      [`${oldApiRoot}/refresh`, { method: "POST" }]
    ] as const) {
      const response = await fetch(`${server!.url}${path}`, init);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ success: false, error: { code: "not_found" } });
    }
  });
});
