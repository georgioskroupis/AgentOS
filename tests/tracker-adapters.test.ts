import { describe, expect, it } from "vitest";
import { createIssueTracker, knownTrackerKinds, registerTrackerAdapter, trackerAdapterForKind, unregisterTrackerAdapterForTests } from "../src/tracker-adapters.js";
import { normalizeTrackerIssue } from "../src/tracker-normalization.js";
import { fakeIssue, fakeServiceConfig } from "./fixtures/agentos-fakes.js";
import type { IssueTracker } from "../src/types.js";

describe("tracker adapter registry", () => {
  it("keeps the Linear adapter registered by default", () => {
    expect(knownTrackerKinds()).toContain("linear");
    expect(trackerAdapterForKind("linear").description).toContain("Linear");
  });

  it("creates a test fake adapter through the same registry path", async () => {
    const kind = "fake-test";
    class FakeTracker implements IssueTracker {
      async fetchCandidates() {
        return [fakeIssue({ labels: ["Bug"], created_at: "2026-05-22T00:00:00.000Z" })];
      }

      async fetchIssueStates() {
        return new Map();
      }
    }

    registerTrackerAdapter({ kind, description: "test fake tracker", create: () => new FakeTracker() });
    try {
      const tracker = createIssueTracker(fakeServiceConfig({ tracker: { ...fakeServiceConfig().tracker, kind } }));
      await expect(tracker.fetchCandidates(["Ready"])).resolves.toEqual([expect.objectContaining({ identifier: "AG-1" })]);
    } finally {
      unregisterTrackerAdapterForTests(kind);
    }
  });

  it("rejects unknown tracker kinds with registered adapter guidance", () => {
    expect(() => trackerAdapterForKind("jira")).toThrow(/unsupported_tracker_kind: jira; registered adapters: .*linear/);
  });

  it("rejects adapters missing required methods", () => {
    const kind = "bad-test";
    registerTrackerAdapter({ kind, description: "bad tracker", create: () => ({ fetchCandidates: async () => [] }) as unknown as IssueTracker });
    try {
      expect(() => createIssueTracker(fakeServiceConfig({ tracker: { ...fakeServiceConfig().tracker, kind } }))).toThrow(/missing required method fetchIssueStates/);
    } finally {
      unregisterTrackerAdapterForTests(kind);
    }
  });

  it("normalizes issue domain fields for adapter outputs", () => {
    expect(
      normalizeTrackerIssue(
        fakeIssue({
          priority: 1.5,
          labels: ["Feature", "Needs-Review"],
          blocked_by: [{ id: 12 as unknown as string, identifier: "AG-0", state: "Done", created_at: "not-a-date", updated_at: "2026-05-22T00:00:00.000Z" }],
          created_at: "bad-date"
        })
      )
    ).toMatchObject({
      priority: null,
      labels: ["feature", "needs-review"],
      created_at: null,
      blocked_by: [{ id: "12", created_at: null, updated_at: "2026-05-22T00:00:00.000Z" }]
    });
  });
});
