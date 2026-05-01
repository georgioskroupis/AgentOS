import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHarness, doctorHarness } from "../src/harness.js";

describe("harness", () => {
  it("installs a profile without overwriting existing files by default", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-harness-"));

    const first = await applyHarness({ repo, profile: "typescript" });
    expect(first.some((change) => change.path === "AGENTS.md" && change.action === "add")).toBe(true);
    expect(first.some((change) => change.path === "docs/quality/TYPESCRIPT.md" && change.action === "add")).toBe(true);
    expect(first.some((change) => change.path === "scripts/agent-create-pr.sh" && change.action === "add")).toBe(true);

    const second = await applyHarness({ repo, profile: "typescript" });
    expect(second.every((change) => change.action === "exists")).toBe(true);

    const doctor = await doctorHarness({ repo, profile: "typescript" });
    expect(doctor.every((change) => change.action === "exists")).toBe(true);
  });

  it("supports dry runs without writing files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-harness-dry-"));
    const changes = await applyHarness({ repo, profile: "base", dryRun: true });
    expect(changes.length).toBeGreaterThan(0);
    await expect(readFile(join(repo, "AGENTS.md"), "utf8")).rejects.toThrow();
  });
});
