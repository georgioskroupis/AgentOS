import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { JsonlLogger } from "../src/logging.js";
import type { MonitorEvent } from "../src/monitor-contracts.js";
import { withRunnerActivityMonitorContext } from "../src/orchestrator-monitor-events.js";
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

  it("emits compact activity_observed events from explicit runner monitor hints", async () => {
    const emitted: MonitorEvent[] = [];
    const logger = new JsonlLogger(await mkdtemp(join(tmpdir(), "agent-os-monitor-activity-")));
    const emitter = createMonitorEmitter({
      logger,
      sink: {
        emit(event) {
          emitted.push(event);
        }
      }
    });

    await emitter.emit("run-1", {
      type: "item/completed",
      issueId: "AG-1",
      issueIdentifier: "AG-1",
      message: "raw runner event",
      timestamp: "2026-05-25T00:00:07.000Z",
      payload: {
        params: { item: { output: "raw command output should stay out of monitor activity" } },
        monitor: {
          kind: "activity_observed",
          spanId: "run-1:implementation:1:step",
          parentSpanId: "run-1:implementation:1",
          turnId: "turn-1",
          label: "Runner command completed",
          timeClass: "agent",
          activity: {
            kind: "command_output",
            label: "Runner command completed",
            command: "npm test",
            stream: "stdout",
            bytesObserved: 2048,
            output: "raw command output should stay out of monitor activity"
          }
        }
      }
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "activity_observed",
      spanId: "run-1:implementation:1:step",
      parentSpanId: "run-1:implementation:1",
      runId: "run-1",
      turnId: "turn-1",
      label: "Runner command completed",
      timeClass: "agent",
      activity: {
        kind: "command_output",
        label: "Runner command completed",
        command: "npm test",
        stream: "stdout",
        bytesObserved: 2048
      }
    });
    expect(JSON.stringify(emitted[0])).not.toContain("raw command output");
  });

  it("maps command execution runner items to sanitized tool timing rows", async () => {
    const emitted: MonitorEvent[] = [];
    const logger = new JsonlLogger(await mkdtemp(join(tmpdir(), "agent-os-monitor-command-row-")));
    const emitter = createMonitorEmitter({
      logger,
      sink: {
        emit(event) {
          emitted.push(event);
        }
      }
    });

    const timing = {
      id: "run-1:implementation:1",
      phase: "implementation",
      label: "implementation turn 1",
      status: "running",
      startedAt: "2026-05-25T00:00:00.000Z"
    };

    await emitter.emit(
      "run-1",
      withRunnerActivityMonitorContext(
        {
          type: "item/started",
          issueId: "AG-1",
          issueIdentifier: "AG-1",
          timestamp: "2026-05-25T00:00:02.000Z",
          payload: {
            params: {
              turnId: "turn-1",
              item: { id: "cmd-1", type: "commandExecution", command: "npm run check:dashboard", status: "inProgress" }
            }
          }
        },
        timing
      )
    );
    await emitter.emit(
      "run-1",
      withRunnerActivityMonitorContext(
        {
          type: "item/completed",
          issueId: "AG-1",
          issueIdentifier: "AG-1",
          timestamp: "2026-05-25T00:00:05.000Z",
          payload: {
            params: {
              turnId: "turn-1",
              item: {
                id: "cmd-1",
                type: "commandExecution",
                command: "npm run check:dashboard",
                status: "completed",
                exitCode: 0,
                output: "raw stdout should stay out"
              }
            }
          }
        },
        timing
      )
    );

    expect(emitted.map((event) => event.kind)).toEqual(["step_started", "step_finished"]);
    expect(emitted[0]).toMatchObject({
      spanId: "run-1:implementation:1:command:cmd-1",
      parentSpanId: "run-1:implementation:1:step",
      turnId: "turn-1",
      label: "Command: npm run check:dashboard",
      status: "active",
      timeClass: "tool",
      result: "running"
    });
    expect(emitted[1]).toMatchObject({
      spanId: "run-1:implementation:1:command:cmd-1",
      parentSpanId: "run-1:implementation:1:step",
      status: "pass",
      timeClass: "tool",
      result: "exit 0"
    });
    expect(JSON.stringify(emitted)).not.toContain("raw stdout");
  });

  it("tags runner updates with the active turn span without copying raw payloads into monitor activity", () => {
    const event = withRunnerActivityMonitorContext(
      {
        type: "thread/tokenUsage/updated",
        issueId: "AG-1",
        issueIdentifier: "AG-1",
        timestamp: "2026-05-25T00:00:08.000Z",
        payload: {
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: { total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
          }
        }
      },
      {
        id: "run-1:implementation:1",
        phase: "implementation",
        label: "implementation turn 1",
        status: "running",
        startedAt: "2026-05-25T00:00:00.000Z"
      }
    );

    expect(event.payload).toMatchObject({
      monitor: {
        kind: "activity_observed",
        spanId: "run-1:implementation:1:step",
        parentSpanId: "run-1:implementation:1",
        turnId: "turn-1",
        label: "Runner token usage observed",
        activity: {
          kind: "token_usage",
          label: "Runner token usage observed",
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15
        }
      }
    });
  });

  it("does not emit token activity for delta or ambiguous generic usage payloads", () => {
    const timing = {
      id: "run-1:implementation:1",
      phase: "implementation",
      label: "implementation turn 1",
      status: "running",
      startedAt: "2026-05-25T00:00:00.000Z"
    };

    const delta = withRunnerActivityMonitorContext(
      {
        type: "thread/tokenUsage/updated",
        issueId: "AG-1",
        issueIdentifier: "AG-1",
        timestamp: "2026-05-25T00:00:08.000Z",
        payload: {
          params: {
            tokenUsage: { delta: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
          }
        }
      },
      timing
    );
    const ambiguous = withRunnerActivityMonitorContext(
      {
        type: "thread/tokenUsage/updated",
        issueId: "AG-1",
        issueIdentifier: "AG-1",
        timestamp: "2026-05-25T00:00:08.000Z",
        payload: {
          params: {
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
          }
        }
      },
      timing
    );

    expect(delta.payload).not.toHaveProperty("monitor");
    expect(ambiguous.payload).not.toHaveProperty("monitor");
  });
});
