import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeIssue } from "./fixtures/agentos-fakes.js";
import { validationEvidenceFinding, verifyValidationEvidence, writeValidationEvidence } from "../src/validation.js";

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
    expect(result.state.errors?.join("\n")).toContain("missing command evidence: npm run agent-check");
    expect(result.state.errors?.join("\n")).toContain("exitCode 1");
    expect(validationEvidenceFinding(result.state)).toMatchObject({ reviewer: "validation", severity: "P1" });
  });
});
