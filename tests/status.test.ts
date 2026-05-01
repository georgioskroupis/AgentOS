import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectIssue } from "../src/status.js";

describe("issue inspection", () => {
  it("shows accepted validation commands and failed historical attempts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-status-"));
    const stateRoot = join(repo, ".agent-os", "state", "issues");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      join(stateRoot, "AG-1.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          issueId: "issue-1",
          issueIdentifier: "AG-1",
          phase: "review",
          validation: {
            status: "passed",
            finalStatus: "passed",
            checkedAt: "2026-05-01T00:00:00.000Z",
            acceptedCommands: [
              {
                name: "npm run agent-check",
                exitCode: 0,
                startedAt: "2026-05-01T00:01:00.000Z",
                finishedAt: "2026-05-01T00:02:00.000Z"
              }
            ],
            failedHistoricalAttempts: [
              {
                name: "npm run agent-check",
                exitCode: 1,
                startedAt: "2026-05-01T00:00:00.000Z",
                finishedAt: "2026-05-01T00:00:10.000Z"
              }
            ]
          },
          updatedAt: "2026-05-01T00:03:00.000Z"
        },
        null,
        2
      ),
      "utf8"
    );

    const output = await inspectIssue(repo, "AG-1");

    expect(output).toContain("Validation: passed (final: passed)");
    expect(output).toContain("Accepted validation commands:");
    expect(output).toContain("npm run agent-check: exitCode 0");
    expect(output).toContain("Failed historical attempts:");
    expect(output).toContain("npm run agent-check: exitCode 1");
  });
});
