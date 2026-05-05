import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeStateStore } from "../src/runtime-state.js";
import type { Issue } from "../src/types.js";

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Runtime issue",
  description: "secret token should not persist",
  priority: 1,
  state: "Ready",
  branch_name: "agent/AG-1",
  url: "https://linear.example/secret",
  labels: ["secret-label"],
  blocked_by: [{ id: "blocked-by-1", identifier: "SEC-1", state: "Todo" }],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z"
};

describe("runtime state", () => {
  it("serializes concurrent mutations and stores only a minimal issue snapshot", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-runtime-state-"));
    const store = new RuntimeStateStore(repo);

    await store.upsertActiveRun({
      issueId: issue.id,
      identifier: issue.identifier,
      issue,
      attempt: null,
      runId: "run-1",
      startedAt: "2026-05-05T10:00:00.000Z"
    });
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.patchActiveRun(issue.id, {
          lastEventAt: `2026-05-05T10:00:${String(index).padStart(2, "0")}.000Z`
        })
      )
    );

    const state = await store.read();
    expect(state.activeRuns).toHaveLength(1);
    expect(state.activeRuns[0].issue).toMatchObject({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: null,
      url: null,
      labels: [],
      blocked_by: []
    });

    const raw = await readFile(join(repo, ".agent-os", "state", "runtime.json"), "utf8");
    expect(raw).not.toContain("secret token");
    expect(raw).not.toContain("secret-label");
    expect(raw).not.toContain("linear.example/secret");
  });
});
