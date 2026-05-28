# Lean Monitor Contract

VER-150 defines the Lean Live Work Profiler boundary before runtime code moves.
The monitor is an optional observability extension. Source-core code may emit
typed events through the source-core-safe sink contract, but snapshot assembly,
UI rendering, and the macOS launcher are extension-owned.

## Source-Core-Safe Contract

Source-core-safe contracts live in `src/monitor-contracts.ts`:

- `MonitorSink`
- `MonitorEvent`
- `MonitorActivity`
- `NullMonitorSink`

`MonitorEvent` distinguishes `eventId`, `spanId`, `parentSpanId`, and optional
`turnId`.
`eventId` is the unique emitted event id. `spanId` is the timing row/span id.
`parentSpanId` is the nested parent row id. `turnId` is a compact runner turn
correlator when the runner exposes one. Start and finish pairs use the same
`spanId`.

`activity_observed` events may carry optional `MonitorActivity` metadata for
compact sub-turn facts. Activities are created through `buildMonitorActivity`,
which preserves only the approved compact typed fields. The supported activity
kinds are exactly `command_output`, `file_change`, `token_usage`, `rate_limit`,
and `generic`. Activity output must not include raw stdout or stderr, raw diffs,
prompts, model responses, full runner payloads, raw rate-limit payloads,
stack traces except compact labels, secrets, or environment values. Rate-limit
activity exposes compact pressure only, not raw limit payloads.
Runner activity observations must be emitted as `activity_observed` events tied
to the active run and monitor span, with `turnId` included only when available.

Core modules must not import snapshot, UI, or launcher contracts. A core caller
that has no monitor configured should use `NullMonitorSink`.

The default orchestration path uses `NullMonitorSink`, preserving existing
behavior when no monitor extension is configured. If a non-null sink is wired
in, sink failures are logged as monitor sink warnings and swallowed; monitor
observability must not fail dispatch, validation, review, or merge behavior.

## Extension-Only Contract

Extension-only contracts live in `src/monitor-extension-contracts.ts`:

- `MonitorSnapshot`
- `TimingRow`
- `TimeSink`
- `HumanAction`
- `LauncherState`
- `LauncherConfig`

`MonitorSnapshot` is assembled from monitor events plus current run context:
runtime state, issue metadata, attempt data, PR/handoff/validation references,
and terminal status. The assembler is extension-owned and is not part of
source-core orchestration.

`HumanAction.required` controls rendering. When `required` is false, the UI
renders the human-action fields as `Not needed`.

The in-memory reducer lives in `src/monitor-aggregator.ts`. It is an
extension-owned `MonitorSink` implementation that combines monitor events and
current run context into `MonitorSnapshot`; source-core modules must not import
it.

The reducer generates Tiny Summary and Human Action text deterministically. It
does not call a model, and generated text is presentation-only: validation
evidence, tracker state, PR metadata, and run artifacts remain the source of
truth. Tiny Summary always contains exactly `Why`, `Build`, and `Done`. Human
Action always contains exactly `Stopped because`, `You should`, `Manual test`,
`Expected result`, and `Recommended next step`, plus the `required` boolean.
Reason codes and changed-surface facts drive the wording, with explicit rules
for docs-only, workflow/config, architecture-check, and UI changes. If a manual
test or expected result cannot be inferred from those facts, the reducer says so
plainly instead of inventing one. Generated text is cached in memory per run and
is regenerated when relevant run context, monitor events, reason code, or
changed-surface facts change.

## Read-Only HTTP API

The optional listener in `src/http-server.ts` exposes exactly these monitor API
routes when a monitor port is configured:

- `GET /api/monitor/v1/snapshot`
- `GET /api/monitor/v1/stream`
- `GET /api/monitor/v1/health`

`/api/monitor/v1/snapshot` returns the current `MonitorSnapshot`.
`/api/monitor/v1/stream` is an SSE stream that emits `monitor_snapshot` events
after monitor state changes and `heartbeat` events while connected. Clients
reconnect by refetching `/api/monitor/v1/snapshot`; the stream is not an event
replay API.

`/api/monitor/v1/health` stays tiny: `ok`, `status`, `serverNow`, and current
run identity when a run is known. The API exposes snapshots only. It must not
serve raw logs, raw monitor events, prompts, or mutation controls.

All non-GET methods on the defined monitor API routes return `405`. Mutation
routes such as `start`, `stop`, `restart`, and `refresh` are not part of the
monitor API.

## Modes

Browser mode reads an already-running monitor endpoint and renders the current
snapshot in a browser. It does not start, stop, or attach to an orchestrator
process.

Standalone Mac mode owns only launcher ergonomics. It reads
`~/Library/Application Support/AgentOS Monitor/config.json`, starts or attaches
to the configured local AgentOS monitor endpoint, and exposes launcher status.
It does not reconstruct run state on the client and does not become a scheduler
control plane.

`agent-os monitor install-macos --repo <repo> --workflow <workflow> --port
<port>` generates or updates a real `AgentOS Monitor.app` bundle and the
matching launcher config. The app bundle is Dock-runnable and contains only a
minimal Electron main/preload shell; the profiler itself remains the static
read-only browser UI served by the local monitor listener.

## Launcher Boundary

`LauncherConfig` is stored as JSON at:

```text
~/Library/Application Support/AgentOS Monitor/config.json
```

It stores `repo`, `workflow`, `host`, `port`, and optional `command`.
`host` is fixed to `127.0.0.1`. A launcher may use the optional command
override to start AgentOS, but the monitor contract does not define process
management behavior beyond `LauncherState`.

The extension-owned local process manager constructs the default command as
`bin/agent-os orchestrator run --repo <repo> --workflow <workflow> --port <port>`
from `LauncherConfig`, waits for `GET /api/monitor/v1/health` before reporting
`running`, and treats an already-healthy monitor endpoint as read-only
`attached` state. Stop is enabled only when the launcher owns the child process
it started. Shutdown sends `SIGTERM` first and escalates to `SIGKILL` only after
the documented graceful timeout expires.

Closing the standalone window does not stop a launcher-owned AgentOS process.
The Stop action is the only standalone UI path that terminates a process started
by the launcher. Attached external daemons are never stopped by the app.

## UI Contract

The monitor has exactly these seven UI sections:

1. Run Header
2. Tiny Summary
3. Current Activity
4. Nested Timing Table
5. Top Time Sinks
6. Human Action
7. Links

The browser UI is the static `dashboard/index.html` profiler. It renders
snapshots from `/api/monitor/v1/snapshot`, applies `monitor_snapshot` stream
updates from `/api/monitor/v1/stream`, keeps active displayed durations ticking
from the authoritative `serverNow`, and renders missing Linear, PR, handoff,
and validation links as disabled placeholders.

Snapshot status is exactly one of:

- `idle`
- `active`
- `waiting`
- `human_action`
- `failed`
- `completed`

## Timing Rules

- Server timestamps are authoritative.
- Rows are ordered by timestamp, then by insertion order as a tie-breaker.
- Active row duration is computed from `serverNow`.
- Finished rows are immutable.
- Terminal snapshots close active rows.
- Sanitized command execution activity may render as `tool` timing rows under
  the active turn span. Command rows expose the compact command label, status,
  elapsed time, and bounded result such as `running` or `exit 0`; they must not
  expose raw stdout or stderr.
- Top time sinks are selected by `selfMs`.
- Retention keeps the active run plus the most recent terminal snapshot.

## Forbidden Legacy Terms

The deletion manifest in `docs/architecture/MONITOR_DELETION_MANIFEST.md`
defines the forbidden legacy terms and the allowlist policy for future checks.
Forbidden-term checks must allowlist the deletion manifest, historical docs
when they are intentionally retained, and the check implementation itself.
