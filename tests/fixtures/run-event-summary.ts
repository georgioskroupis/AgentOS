import { join } from "node:path";
import { RunArtifactStore } from "../../src/runs.js";
import type { Issue } from "../../src/types.js";

export const oversizedRunEventSentinels = {
  commandOutput: "RAW_COMMAND_OUTPUT_SHOULD_NOT_SURFACE",
  diff: "RAW_DIFF_BODY_SHOULD_NOT_SURFACE",
  coverage: "RAW_COVERAGE_BODY_SHOULD_NOT_SURFACE",
  generic: "RAW_GENERIC_PAYLOAD_SHOULD_NOT_SURFACE"
};

export async function createOversizedRunEventSummaryFixture(repo: string, issue: Issue): Promise<{
  store: RunArtifactStore;
  runId: string;
  eventsPath: string;
}> {
  const store = new RunArtifactStore(repo);
  const summary = await store.startRun({
    issue,
    attempt: 1,
    workspace: { path: join(repo, "workspace"), workspaceKey: issue.identifier, createdNow: true }
  });

  await store.writeEvent(summary.runId, {
    type: "codex_stdout",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    message: "oversized command output",
    payload: { stdout: `${oversizedRunEventSentinels.commandOutput}\n`.repeat(500) },
    timestamp: "2026-05-01T00:00:00.000Z"
  });
  await store.writeEvent(summary.runId, {
    type: "git_diff",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    message: "oversized diff",
    payload: { diff: `diff --git a/src/private.ts b/src/private.ts\n+${oversizedRunEventSentinels.diff}\n`.repeat(250) },
    timestamp: "2026-05-01T00:00:01.000Z"
  });
  await store.writeEvent(summary.runId, {
    type: "coverage_report",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    message: "oversized coverage output",
    payload: { lcov: `SF:src/private.ts\nDA:1,1\nTN:${oversizedRunEventSentinels.coverage}\n`.repeat(300) },
    timestamp: "2026-05-01T00:00:02.000Z"
  });
  await store.writeEvent(summary.runId, {
    type: "generic_payload",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    message: "oversized generic payload",
    payload: { data: `${oversizedRunEventSentinels.generic}\n`.repeat(500) },
    timestamp: "2026-05-01T00:00:03.000Z"
  });

  return {
    store,
    runId: summary.runId,
    eventsPath: join(repo, ".agent-os", "runs", summary.runId, "events.jsonl")
  };
}
