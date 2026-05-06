import { describe, expect, it } from "vitest";
import { validationTimingFromEvidence } from "../src/phase-timing.js";
import type { ValidationEvidenceCheck } from "../src/validation.js";

describe("phase timing", () => {
  it("does not persist raw final validation command strings", () => {
    const timing = validationTimingFromEvidence(
      validationCheck({
        finalResult: {
          status: "passed",
          command: "curl -H 'Authorization: Bearer one-off-secret' https://example.test",
          exitCode: 0,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:05.000Z"
        }
      }),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:05.000Z"
    );

    const serialized = JSON.stringify({ label: timing.label, metadata: timing.metadata });
    expect(timing.label).toBe("validation final result");
    expect(timing.metadata).toEqual(expect.objectContaining({ timingSource: "finalResult", finalResultHasCommand: true, exitCode: 0 }));
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("one-off-secret");
    expect(timing.metadata).not.toHaveProperty("command");
  });

  it("does not persist raw validation command names from command intervals", () => {
    const timing = validationTimingFromEvidence(
      validationCheck({
        commands: [
          {
            name: "curl -H 'X-Api-Key: one-off-secret' https://example.test",
            exitCode: 0,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:00:05.000Z"
          }
        ]
      }),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:05.000Z"
    );

    const serialized = JSON.stringify({ label: timing.label, metadata: timing.metadata });
    expect(timing.metadata).toEqual(expect.objectContaining({ timingSource: "commands", timedCommandCount: 1 }));
    expect(serialized).not.toContain("X-Api-Key");
    expect(serialized).not.toContain("one-off-secret");
    expect(timing.metadata).not.toHaveProperty("commandNames");
  });
});

function validationCheck(overrides: Partial<NonNullable<ValidationEvidenceCheck["evidence"]>>): ValidationEvidenceCheck {
  const commands = overrides.commands ?? [
    {
      name: "npm run agent-check",
      exitCode: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:05.000Z"
    }
  ];
  return {
    state: {
      status: "passed",
      path: ".agent-os/validation/AG-1.json",
      checkedAt: "2026-01-01T00:00:06.000Z",
      finalStatus: "passed",
      acceptedCommands: commands.map((command) => ({
        name: command.name,
        exitCode: command.exitCode,
        startedAt: command.startedAt,
        finishedAt: command.finishedAt
      }))
    },
    evidence: {
      schemaVersion: 1,
      issueIdentifier: "AG-1",
      status: "passed",
      commands,
      ...overrides
    }
  };
}
