import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectMode, profileProject } from "../src/project-profiler.js";

describe("project profiler", () => {
  it("detects greenfield and existing projects", async () => {
    const greenfield = await mkdtemp(join(tmpdir(), "agent-os-profiler-empty-"));
    const existing = await mkdtemp(join(tmpdir(), "agent-os-profiler-existing-"));
    await writeFile(join(existing, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");

    await expect(detectProjectMode(greenfield)).resolves.toBe("greenfield");
    await expect(detectProjectMode(existing)).resolves.toBe("existing");
  });

  it("infers TypeScript and web profiles from manifests", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-profiler-ts-"));
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "web-app", dependencies: { react: "^18.0.0" }, scripts: { test: "vitest", typecheck: "tsc --noEmit" } }),
      "utf8"
    );
    await writeFile(join(repo, "tsconfig.json"), "{}", "utf8");

    const profile = await profileProject({ repo, useCodexSummary: false });

    expect(profile.mode).toBe("existing");
    expect(profile.recommendedProfile).toBe("web");
    expect(profile.checkCommands).toContain("npm run typecheck");
    expect(profile.testCommands).toContain("npm test");
  });

  it("uses a Codex summary provider when available", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-profiler-codex-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "api" }), "utf8");

    const profile = await profileProject({
      repo,
      useCodexSummary: true,
      summaryProvider: async () => ({
        recommendedProfile: "api",
        stack: ["Node.js", "API"],
        architectureNotes: ["Codex summary note."]
      })
    });

    expect(profile.summarySource).toBe("codex");
    expect(profile.recommendedProfile).toBe("api");
    expect(profile.architectureNotes).toEqual(["Codex summary note."]);
  });

  it("removes transient setup observations from Codex summaries", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-profiler-codex-sanitize-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "api" }), "utf8");

    const profile = await profileProject({
      repo,
      useCodexSummary: true,
      summaryProvider: async () => ({
        architectureNotes: [
          "Primary source is under src/.",
          "The worktree has pre-existing uncommitted changes; inspection was read-only and no edits or mutating commands were run."
        ]
      })
    });

    expect(profile.architectureNotes).toEqual(["Primary source is under src/."]);
  });

  it("records Codex summary fallback errors", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-profiler-codex-fail-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "api" }), "utf8");

    const profile = await profileProject({
      repo,
      useCodexSummary: true,
      summaryProvider: async () => {
        throw new Error("codex unavailable");
      }
    });

    expect(profile.summarySource).toBe("static");
    expect(profile.summaryError).toContain("codex unavailable");
  });

  it("records empty Codex summary fallback", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-profiler-codex-empty-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "api" }), "utf8");

    const profile = await profileProject({
      repo,
      useCodexSummary: true,
      summaryProvider: async () => null
    });

    expect(profile.summarySource).toBe("static");
    expect(profile.summaryError).toContain("no structured JSON");
  });

  it("does not write files during dry static profiling", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-profiler-readonly-"));
    await profileProject({ repo, mode: "greenfield", useCodexSummary: false });
    await expect(readFile(join(repo, "AGENTS.md"), "utf8")).rejects.toThrow();
  });
});
