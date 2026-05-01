import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { fakeIssue } from "./fixtures/agentos-fakes.js";
import { validationEvidenceFinding, verifyValidationEvidence, writeValidationEvidence } from "../src/validation.js";

const execFileAsync = promisify(execFile);

describe("validation evidence", () => {
  it("accepts fresh matching JSON evidence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-"));
    const now = new Date().toISOString();
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "passed",
      commands: [{ name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace
    });

    expect(result.state).toMatchObject({ status: "passed" });
    expect(validationEvidenceFinding(result.state)).toBeNull();
  });

  it("rejects stale, mismatched, or failed evidence as a review finding", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-bad-"));
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "OTHER-1",
      status: "failed",
      commands: [{ name: "npm run test", exitCode: 1, startedAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:00:01.000Z" }]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      now: new Date("2026-05-01T00:00:00.000Z")
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.errors?.join("\n")).toContain("issueIdentifier mismatch");
    expect(result.state.errors?.join("\n")).toContain("missing passing command evidence: npm run agent-check");
    expect(result.state.failedHistoricalAttempts).toEqual([
      { name: "npm run test", exitCode: 1, startedAt: "2020-01-01T00:00:00.000Z", finishedAt: "2020-01-01T00:00:01.000Z" }
    ]);
    expect(validationEvidenceFinding(result.state)).toMatchObject({ reviewer: "validation", severity: "P1" });
  });

  it("accepts final passed evidence with earlier failed historical attempts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-final-pass-"));
    const now = new Date().toISOString();
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "passed",
      commands: [
        { name: "npm run agent-check", exitCode: 1, startedAt: now, finishedAt: now },
        { name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }
      ]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace
    });

    expect(result.state.status).toBe("passed");
    expect(result.state.acceptedCommands).toEqual([
      { name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }
    ]);
    expect(result.state.failedHistoricalAttempts).toEqual([
      { name: "npm run agent-check", exitCode: 1, startedAt: now, finishedAt: now }
    ]);
    expect(validationEvidenceFinding(result.state)).toBeNull();
  });

  it("rejects final passed evidence when the repo head does not match", async () => {
    const workspace = await gitWorkspace();
    const now = new Date().toISOString();
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      repoHead: "0000000000000000000000000000000000000000",
      status: "passed",
      commands: [{ name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now }]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.errors?.join("\n")).toContain("repoHead mismatch");
    expect(validationEvidenceFinding(result.state)).toMatchObject({ reviewer: "validation", severity: "P1" });
  });

  it("rejects final failed evidence even when an earlier command passed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-final-failed-"));
    const now = new Date().toISOString();
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "failed",
      commands: [
        { name: "npm run agent-check", exitCode: 0, startedAt: now, finishedAt: now },
        { name: "npm run agent-check", exitCode: 1, startedAt: now, finishedAt: now }
      ]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.errors?.join("\n")).toContain("final validation status is not passed");
    expect(validationEvidenceFinding(result.state)).toMatchObject({ reviewer: "validation", severity: "P1" });
  });
});

async function gitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-git-"));
  await execFileAsync("git", ["init"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "agentos@example.test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "AgentOS Test"], { cwd: workspace });
  await writeFile(join(workspace, "README.md"), "test\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspace });
  return workspace;
}
