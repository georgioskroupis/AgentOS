import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { fakeIssue } from "./fixtures/agentos-fakes.js";
import { validationEvidenceFinding, verifyValidationEvidence, writeValidationEvidence } from "../src/validation.js";

const execFileAsync = promisify(execFile);
const VALIDATION_NOW = new Date("2026-05-01T00:00:00.000Z");
const VALIDATION_NOW_ISO = VALIDATION_NOW.toISOString();
const INTENTIONALLY_STALE_COMMAND = {
  name: "npm run test",
  exitCode: 1,
  startedAt: "2020-01-01T00:00:00.000Z",
  finishedAt: "2020-01-01T00:00:01.000Z"
};

function freshCommand(name = "npm run agent-check", exitCode = 0) {
  return { name, exitCode, startedAt: VALIDATION_NOW_ISO, finishedAt: VALIDATION_NOW_ISO };
}

describe("validation evidence", () => {
  it("accepts fresh matching JSON evidence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-"));
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "passed",
      commands: [freshCommand()]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      now: VALIDATION_NOW
    });

    expect(result.state).toMatchObject({ status: "passed", checkedAt: VALIDATION_NOW_ISO });
    expect(validationEvidenceFinding(result.state)).toBeNull();
  });

  it("rejects stale, mismatched, or failed evidence as a review finding", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-bad-"));
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "OTHER-1",
      status: "failed",
      commands: [INTENTIONALLY_STALE_COMMAND]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      now: VALIDATION_NOW
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.errors?.join("\n")).toContain("issueIdentifier mismatch");
    expect(result.state.errors?.join("\n")).toContain("missing passing command evidence: npm run agent-check");
    expect(result.state.errors?.join("\n")).toContain("npm run test: validation evidence is stale");
    expect(result.state.failedHistoricalAttempts).toEqual([INTENTIONALLY_STALE_COMMAND]);
    expect(validationEvidenceFinding(result.state)).toMatchObject({ reviewer: "validation", severity: "P1" });
  });

  it("accepts final passed evidence with earlier failed historical attempts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-final-pass-"));
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "passed",
      commands: [
        freshCommand("npm run agent-check", 1),
        freshCommand()
      ]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      now: VALIDATION_NOW
    });

    expect(result.state.status).toBe("passed");
    expect(result.state.acceptedCommands).toEqual([
      freshCommand()
    ]);
    expect(result.state.failedHistoricalAttempts).toEqual([
      freshCommand("npm run agent-check", 1)
    ]);
    expect(validationEvidenceFinding(result.state)).toBeNull();
  });

  it("preserves additional passing command and GitHub CI evidence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-ci-"));
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "passed",
      commands: [
        freshCommand(),
        freshCommand("npm test -- tests/registry-orchestrator.test.ts")
      ],
      githubCi: {
        status: "passed",
        headSha: "abc123",
        source: "github-actions",
        checkedAt: VALIDATION_NOW_ISO
      }
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      now: VALIDATION_NOW
    });

    expect(result.state.status).toBe("passed");
    expect(result.state.additionalPassingCommands).toEqual([freshCommand("npm test -- tests/registry-orchestrator.test.ts")]);
    expect(result.state.githubCi).toEqual({
      status: "passed",
      headSha: "abc123",
      source: "github-actions",
      checkedAt: VALIDATION_NOW_ISO
    });
    expect(validationEvidenceFinding(result.state)).toBeNull();
  });

  it("rejects final passed evidence when the repo head does not match", async () => {
    const workspace = await gitWorkspace();
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      repoHead: "0000000000000000000000000000000000000000",
      status: "passed",
      commands: [freshCommand()]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      now: VALIDATION_NOW
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.errors?.join("\n")).toContain("repoHead mismatch");
    expect(validationEvidenceFinding(result.state)).toMatchObject({ reviewer: "validation", severity: "P1" });
  });

  it("reuses previous-run validation evidence when repoHead matches the current code", async () => {
    const workspace = await gitWorkspace();
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
    const repoHead = stdout.trim();
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      runId: "run_previous",
      repoHead,
      status: "passed",
      commands: [freshCommand()]
    });

    const strictResult = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      runId: "run_current",
      now: VALIDATION_NOW
    });
    expect(strictResult.state.status).toBe("failed");
    expect(strictResult.state.errors?.join("\n")).toContain("runId mismatch");

    const reusableResult = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      runId: "run_current",
      allowReusableRunEvidence: true,
      now: VALIDATION_NOW
    });
    expect(reusableResult.state).toMatchObject({
      status: "passed",
      runId: "run_previous",
      repoHead,
      budget: {
        status: "reused",
        fullValidationRunsForHead: 1,
        currentRunId: "run_current",
        evidenceRunId: "run_previous"
      }
    });
  });

  it("flags duplicate full validation runs for the same evidence head", async () => {
    const workspace = await gitWorkspace();
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      runId: "run_current",
      repoHead: stdout.trim(),
      status: "passed",
      commands: [freshCommand("npm run agent-check", 0), freshCommand("npm run agent-check", 0)]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      runId: "run_current",
      now: VALIDATION_NOW
    });

    expect(result.state.status).toBe("failed");
    expect(result.state.budget).toMatchObject({ status: "exceeded", fullValidationRunsForHead: 2 });
    expect(result.state.errors?.join("\n")).toContain("full validation rerun budget exceeded");
  });

  it("reuses matching validation evidence without requiring a recorded runId", async () => {
    const workspace = await gitWorkspace();
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
    const repoHead = stdout.trim();
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      repoHead,
      status: "passed",
      commands: [freshCommand()]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      runId: "run_current",
      allowReusableRunEvidence: true,
      now: VALIDATION_NOW
    });

    expect(result.state).toMatchObject({
      status: "passed",
      repoHead
    });
    expect(result.state.runId).toBeUndefined();
  });

  it("rejects final failed evidence even when an earlier command passed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-os-validation-final-failed-"));
    await writeValidationEvidence(join(workspace, ".agent-os", "validation", "AG-1.json"), {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "failed",
      commands: [
        freshCommand(),
        freshCommand("npm run agent-check", 1)
      ]
    });

    const result = await verifyValidationEvidence({
      issue: fakeIssue(),
      handoff: "AgentOS-Outcome: implemented\nValidation-JSON: .agent-os/validation/AG-1.json",
      workspacePath: workspace,
      now: VALIDATION_NOW
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
