import { describe, expect, it } from "vitest";
import { TrackerLifecycleController } from "../src/lifecycle-controller.js";
import type { LifecycleEvent } from "../src/lifecycle-events.js";
import type { JsonlLogger } from "../src/logging.js";
import type { TrackerCapabilities } from "../src/tracker-boundaries.js";
import type { AgentOSLogEntry } from "../src/logging.js";
import type { ServiceConfig } from "../src/types.js";
import { fakeIssue, fakeServiceConfig } from "./fixtures/agentos-fakes.js";

describe("TrackerLifecycleController", () => {
  it("routes state_transition_requested events to tracker moves", async () => {
    const moves: Array<{ issue: string; state: string }> = [];
    const { controller } = controllerFixture({
      tracker: {
        async move(issue, state) {
          moves.push({ issue, state });
        }
      }
    });

    await expect(controller.record(event({ type: "state_transition_requested", requestedState: "In Progress" }))).resolves.toMatchObject({
      trackerUpdateResult: "applied"
    });

    expect(moves).toEqual([{ issue: "AG-1", state: "In Progress" }]);
  });

  it("returns unsupported for state transitions without requested state or move capability", async () => {
    await expect(controllerFixture().controller.record(event({ type: "state_transition_requested" }))).resolves.toMatchObject({
      trackerUpdateResult: "unsupported"
    });
    await expect(controllerFixture({ tracker: { move: undefined } }).controller.record(event({ type: "state_transition_requested", requestedState: "In Progress" }))).resolves.toMatchObject({
      trackerUpdateResult: "unsupported"
    });
  });

  it("routes progress_comment events without keys to tracker comments", async () => {
    const comments: Array<{ issue: string; body: string }> = [];
    const { controller } = controllerFixture({
      tracker: {
        async comment(issue, body) {
          comments.push({ issue, body });
        }
      }
    });

    await expect(controller.record(event({ type: "progress_comment", commentBody: "Lifecycle note." }))).resolves.toMatchObject({
      trackerUpdateResult: "applied"
    });

    expect(comments).toEqual([{ issue: "AG-1", body: "Lifecycle note." }]);
  });

  it("routes keyed progress_comment events to upsert comments with AgentOS lifecycle markers", async () => {
    const upserts: Array<{ issue: string; body: string; key: string }> = [];
    const { controller } = controllerFixture({
      tracker: {
        async upsertComment(issue, body, key) {
          upserts.push({ issue, body, key });
        }
      }
    });

    await expect(controller.record(event({ type: "progress_comment", commentBody: "Started.", commentKey: "run_started" }))).resolves.toMatchObject({
      trackerUpdateResult: "applied"
    });

    expect(upserts).toEqual([
      {
        issue: "AG-1",
        body: "<!-- agentos:event=run_started:AG-1 -->\nStarted.",
        key: "run_started:AG-1"
      }
    ]);
  });

  it("logs tracker move and comment failures as linear_update_failed", async () => {
    const fixture = controllerFixture({
      tracker: {
        async move() {
          throw new Error("move exploded");
        },
        async comment() {
          throw new Error("comment exploded");
        }
      }
    });

    await expect(fixture.controller.record(event({ type: "state_transition_requested", requestedState: "Human Review" }))).resolves.toMatchObject({
      trackerUpdateResult: "failed"
    });
    await expect(fixture.controller.record(event({ type: "progress_comment", commentBody: "Comment body." }))).resolves.toMatchObject({
      trackerUpdateResult: "failed"
    });

    expect(fixture.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "linear_update_failed", message: "move to Human Review: move exploded" }),
        expect.objectContaining({ type: "linear_update_failed", message: "comment: comment exploded" })
      ])
    );
  });

  it("blocks move and comment writes when the tracker issue is already in review state", async () => {
    const moves: string[] = [];
    const comments: string[] = [];
    const { controller } = controllerFixture({
      issueState: "Human Review",
      tracker: {
        async move() {
          moves.push("move");
        },
        async comment() {
          comments.push("comment");
        },
        async upsertComment() {
          comments.push("upsert");
        }
      }
    });

    await expect(controller.record(event({ type: "state_transition_requested", requestedState: "In Progress" }))).resolves.toMatchObject({
      trackerUpdateResult: "blocked"
    });
    await expect(controller.record(event({ type: "progress_comment", commentBody: "Blocked.", commentKey: "blocked" }))).resolves.toMatchObject({
      trackerUpdateResult: "blocked"
    });

    expect(moves).toEqual([]);
    expect(comments).toEqual([]);
  });

  it("preserves lifecycle permissions when orchestrator tracker writes are disabled", async () => {
    const writes: string[] = [];
    const { controller } = controllerFixture({
      config: fakeServiceConfig({ lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned" } }),
      tracker: {
        async move() {
          writes.push("move");
        },
        async comment() {
          writes.push("comment");
        }
      }
    });

    await expect(controller.record(event({ type: "state_transition_requested", requestedState: "In Progress" }))).resolves.toMatchObject({
      trackerUpdateResult: "unsupported"
    });
    await expect(controller.record(event({ type: "progress_comment", commentBody: "Should not write." }))).resolves.toMatchObject({
      trackerUpdateResult: "unsupported"
    });

    expect(writes).toEqual([]);
  });

  it("allows enumerated scheduler safety writes in agent-owned mode and logs the safety reason", async () => {
    const writes: string[] = [];
    const fixture = controllerFixture({
      config: fakeServiceConfig({ lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned" } }),
      tracker: {
        async move(issue, state) {
          writes.push(`${issue} -> ${state}`);
        },
        async upsertComment(issue, body, key) {
          writes.push(`${issue} ${key} ${body}`);
          return "created";
        }
      }
    });

    await expect(
      fixture.controller.record(event({
        actor: "scheduler_safety",
        type: "state_transition_requested",
        requestedState: "Human Review",
        safetyReason: "pre_dispatch_safety_block"
      }))
    ).resolves.toMatchObject({ trackerUpdateResult: "applied" });
    await expect(
      fixture.controller.record(event({
        actor: "scheduler_safety",
        type: "progress_comment",
        commentBody: "Safety bookkeeping.",
        commentKey: "planning_recommended",
        safetyReason: "pre_dispatch_safety_block"
      }))
    ).resolves.toMatchObject({ trackerUpdateResult: "applied" });

    expect(writes).toHaveLength(2);
    expect(fixture.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "scheduler_safety", message: "pre_dispatch_safety_block:move:applied" }),
        expect.objectContaining({ type: "scheduler_safety", message: "pre_dispatch_safety_block:comment:applied" })
      ])
    );
  });

  it("rejects scheduler safety writes without an allowed reason or with substantive content", async () => {
    const writes: string[] = [];
    const fixture = controllerFixture({
      config: fakeServiceConfig({ lifecycle: { ...fakeServiceConfig().lifecycle, mode: "agent-owned" } }),
      tracker: {
        async move() {
          writes.push("move");
        },
        async comment() {
          writes.push("comment");
        }
      }
    });

    await expect(fixture.controller.record(event({ actor: "scheduler_safety", type: "state_transition_requested", requestedState: "Human Review" }))).resolves.toMatchObject({
      trackerUpdateResult: "unsupported"
    });
    await expect(
      fixture.controller.record(event({
        actor: "scheduler_safety",
        type: "progress_comment",
        commentBody: "Substantive content should stay agent-owned.",
        commentKind: "substantive",
        safetyReason: "pre_dispatch_safety_block"
      }))
    ).resolves.toMatchObject({ trackerUpdateResult: "unsupported" });

    expect(writes).toEqual([]);
  });
});

function controllerFixture(input: { config?: ServiceConfig; issueState?: string; tracker?: Partial<TrackerCapabilities> } = {}): {
  controller: TrackerLifecycleController;
  logEntries: Array<Omit<AgentOSLogEntry, "timestamp"> & { timestamp?: string }>;
} {
  const issue = fakeIssue({ state: input.issueState ?? "Ready" });
  const logEntries: Array<Omit<AgentOSLogEntry, "timestamp"> & { timestamp?: string }> = [];
  const logger = {
    async write(entry: Omit<AgentOSLogEntry, "timestamp"> & { timestamp?: string }): Promise<AgentOSLogEntry> {
      logEntries.push(entry);
      return { timestamp: entry.timestamp ?? "2026-05-23T00:00:00.000Z", ...entry };
    }
  } as unknown as JsonlLogger;
  const tracker: TrackerCapabilities = {
    async fetchCandidates() {
      return [issue];
    },
    async fetchIssueStates(issueIds) {
      return new Map(issueIds.map((issueId) => [issueId, issueId === issue.id ? issue : null]));
    },
    async move() {},
    async comment() {},
    ...input.tracker
  };
  return {
    controller: new TrackerLifecycleController({
      config: input.config ?? fakeServiceConfig(),
      tracker,
      logger
    }),
    logEntries
  };
}

function event(overrides: Partial<LifecycleEvent> & Pick<LifecycleEvent, "type">): LifecycleEvent {
  return {
    schemaVersion: 1,
    actor: "extension",
    issueId: "issue-1",
    issueIdentifier: "AG-1",
    issueState: "Ready",
    source: "orchestrator",
    createdAt: "2026-05-23T00:00:00.000Z",
    ...overrides
  };
}
