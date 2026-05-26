import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { JsonlLogger } from "../src/logging.js";
import type { MonitorEvent } from "../src/monitor-contracts.js";
import { createMonitorEmitter } from "../src/monitor-sink.js";

describe("monitor emitter", () => {
  it("derives stage, loop, validation, wait, model, and step monitor events from run events", async () => {
    const emitted: MonitorEvent[] = [];
    const logger = new JsonlLogger(await mkdtemp(join(tmpdir(), "agent-os-monitor-emitter-")));
    const emitter = createMonitorEmitter({
      logger,
      sink: {
        emit(event) {
          emitted.push(event);
        }
      }
    });

    await emitter.emit("run-1", {
      type: "phase_started",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "implementation turn 1",
      timestamp: "2026-05-25T00:00:00.000Z",
      payload: { timing: { id: "phase-1", phase: "implementation", label: "implementation turn 1", status: "running", metadata: { turnNumber: 1, maxTurns: 3 } } }
    });
    await emitter.emit("run-1", {
      type: "turn_started",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "implementation turn 1",
      timestamp: "2026-05-25T00:00:01.000Z",
      payload: { turnNumber: 1, maxTurns: 3 }
    });
    await emitter.emit("run-1", {
      type: "model_route_selected",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "implementation: inherited",
      timestamp: "2026-05-25T00:00:02.000Z",
      payload: { role: "implementation", model: "gpt-5.5", attempt: 1 }
    });
    await emitter.emit("run-1", {
      type: "model_finished",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "implementation model finished",
      timestamp: "2026-05-25T00:00:03.000Z",
      payload: { role: "implementation", model: "gpt-5.5", attempt: 1, status: "succeeded" }
    });
    await emitter.emit("run-1", {
      type: "review_model_finished",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "tests review model finished",
      timestamp: "2026-05-25T00:00:04.000Z",
      payload: { role: "tests-review", model: "gpt-5.5-mini", reviewer: "tests", attempt: 1, status: "succeeded" }
    });
    await emitter.emit("run-1", {
      type: "validation_command_finished",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "npm run agent-check",
      timestamp: "2026-05-25T00:00:05.000Z",
      payload: { command: "npm run agent-check", exitCode: 1, status: "failed", startedAt: "2026-05-25T00:00:03.000Z", finishedAt: "2026-05-25T00:00:05.000Z" }
    });
    await emitter.emit("run-1", {
      type: "phase_started",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "CI wait",
      timestamp: "2026-05-25T00:00:06.000Z",
      payload: { timing: { id: "wait-1", phase: "ci-wait", label: "CI wait", status: "waiting" } }
    });

    expect(emitted.map((event) => event.kind)).toEqual([
      "stage_started",
      "loop_started",
      "loop_iteration_started",
      "step_started",
      "model_started",
      "model_finished",
      "model_finished",
      "validation_finished",
      "wait_started"
    ]);
    expect(emitted.find((event) => event.kind === "loop_iteration_started")).toMatchObject({
      label: "iteration 1",
      iteration: { current: 1, max: 3, label: "iteration" },
      timeClass: "agent"
    });
    expect(emitted.find((event) => event.kind === "model_started")).toMatchObject({
      model: { name: "gpt-5.5", role: "implementation" },
      timeClass: "agent"
    });
    expect(emitted.find((event) => event.label === "review model finished")).toMatchObject({
      model: { name: "gpt-5.5-mini", role: "review" },
      timeClass: "agent"
    });
    expect(emitted.find((event) => event.kind === "validation_finished")).toMatchObject({
      status: "failed",
      validation: { command: "npm run agent-check", durationMs: 2000, status: "fail", exitCode: 1 }
    });
    expect(emitted.find((event) => event.kind === "wait_started")).toMatchObject({
      label: "CI wait",
      status: "waiting",
      timeClass: "external-wait"
    });
  });
});
