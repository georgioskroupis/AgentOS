# Lean Monitor Contract

VER-150 defines the Lean Live Work Profiler boundary before runtime code moves.
The monitor is an optional observability extension. Source-core code may emit
typed events through the source-core-safe sink contract, but snapshot assembly,
UI rendering, and the macOS launcher are extension-owned.

## Source-Core-Safe Contract

Source-core-safe contracts live in `src/monitor-contracts.ts`:

- `MonitorSink`
- `MonitorEvent`
- `NullMonitorSink`

`MonitorEvent` distinguishes `eventId`, `spanId`, and `parentSpanId`.
`eventId` is the unique emitted event id. `spanId` is the timing row/span id.
`parentSpanId` is the nested parent row id. Start and finish pairs use the same
`spanId`.

Core modules must not import snapshot, UI, or launcher contracts. A core caller
that has no monitor configured should use `NullMonitorSink`.

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

## Modes

Browser mode reads an already-running monitor endpoint and renders the current
snapshot in a browser. It does not start, stop, or attach to an orchestrator
process.

Standalone Mac mode owns only launcher ergonomics. It reads
`~/Library/Application Support/AgentOS Monitor/config.json`, starts or attaches
to the configured local AgentOS monitor endpoint, and exposes launcher status.
It does not reconstruct run state on the client and does not become a scheduler
control plane.

## Launcher Boundary

`LauncherConfig` is stored as JSON at:

```text
~/Library/Application Support/AgentOS Monitor/config.json
```

It stores `repo`, `workflow`, `host`, `port`, and optional `command`.
`host` is fixed to `127.0.0.1`. A launcher may use the optional command
override to start AgentOS, but the monitor contract does not define process
management behavior beyond `LauncherState`.

## UI Contract

The monitor has exactly these seven UI sections:

1. Run Header
2. Tiny Summary
3. Current Activity
4. Nested Timing Table
5. Top Time Sinks
6. Human Action
7. Links

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
- Top time sinks are selected by `selfMs`.
- Retention keeps the active run plus the most recent terminal snapshot.

## Forbidden Legacy Terms

The deletion manifest in `docs/architecture/MONITOR_DELETION_MANIFEST.md`
defines the forbidden legacy terms and the allowlist policy for future checks.
Forbidden-term checks must allowlist the deletion manifest, historical docs
when they are intentionally retained, and the check implementation itself.
