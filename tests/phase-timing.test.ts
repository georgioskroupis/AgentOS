import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistPhaseTimingToRun, validationTimingFromEvidence } from "../src/phase-timing.js";
import { RunArtifactStore } from "../src/runs.js";
import type { Issue } from "../src/types.js";
import type { ValidationEvidenceCheck } from "../src/validation.js";

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Timing issue",
  description: null,
  priority: 1,
  state: "Merging",
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null
};

describe("phase timing", () => {
  it("reuses an existing open waiting phase for a run and phase", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-phase-wait-"));
    const store = new RunArtifactStore(repo);
    const run = await store.startRun({ issue, attempt: null });

    await persistPhaseTimingToRun(store, run.runId, issue, {
      phase: "ci-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:00:00.000Z",
      label: "ci wait started",
      metadata: { prUrl: "https://github.com/o/r/pull/1", reason: "checks pending" }
    });
    await persistPhaseTimingToRun(store, run.runId, issue, {
      phase: "ci-wait",
      status: "waiting",
      startedAt: "2026-01-01T00:05:00.000Z",
      label: "ci wait started",
      metadata: { prUrl: "https://github.com/o/r/pull/1", reason: "checks still pending" }
    });

    const inspected = await store.inspect(run.runId);
    expect(inspected.summary.timing?.phases.filter((phase) => phase.phase === "ci-wait")).toEqual([
      expect.objectContaining({
        status: "waiting",
        startedAt: "2026-01-01T00:00:00.000Z",
        metadata: expect.objectContaining({ reason: "checks still pending" })
      })
    ]);
    const startedEvents = (await store.replay(run.runId)).filter((event) => event.type === "phase_started" && (event.payload as { timing?: { phase?: string } }).timing?.phase === "ci-wait");
    expect(startedEvents).toHaveLength(1);
  });

  it("preserves existing artifact hashes when inactive timing events are appended", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-phase-hash-"));
    const store = new RunArtifactStore(repo);
    const run = await store.startRun({ issue, attempt: null });
    await store.writePrompt(run.runId, "original prompt");
    await store.writeHandoff(run.runId, "original handoff");
    await store.completeRun(run.runId, { status: "succeeded" });
    await appendFile(join(repo, ".agent-os", "runs", run.runId, "prompt.md"), "\ntampered", "utf8");

    await persistPhaseTimingToRun(
      store,
      run.runId,
      issue,
      {
        phase: "ci-wait",
        status: "waiting",
        startedAt: "2026-01-01T00:00:00.000Z",
        label: "ci wait started"
      },
      { activeRunId: null }
    );

    const inspected = await store.inspect(run.runId);
    expect(inspected.warnings).toEqual(["artifact hash mismatch: prompt.md"]);
  });

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
