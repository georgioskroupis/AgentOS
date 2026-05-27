# Monitor Optimization Gap Inventory

<!-- agentos:planned-issue=monitor-opt-01-dock-baseline -->

This page records the monitor optimization baseline for follow-up slices. It is
documentation-only: runtime behavior, monitor routes, launcher ownership, and
Dock app launch behavior stay as implemented in the lean monitor contract.

## Current UX Gaps

1. The monitor has a working lean profiler, but operators still need clearer
   scan paths for current activity, timing depth, and top sinks during long
   agent runs.
2. Standalone Mac mode exposes launcher state, but the transition from stopped,
   starting, attached, running, failed, and stopped states needs stronger visual
   treatment and failure recovery copy.
3. Browser mode and standalone mode share the same profiler, but their mode
   boundaries need to remain obvious so browser users do not expect process
   controls.
4. Human-action output is deterministic and bounded, but follow-up UI work
   should make required action, proof links, and validation links easier to
   identify without adding raw logs or model output.
5. Existing dashboard checks cover the lean contract, but future UI changes need
   focused proof that the Dock launcher, standalone controls, and read-only
   browser surface still work together.

## Ordered Follow-Up Slices

1. Dock launcher baseline: check in this gap inventory and preserve the current
   known-good Dock launch flow without runtime changes.
2. Launcher status polish: improve standalone status rendering for start,
   attach, stop, and failure states while preserving process ownership.
3. Activity scanability: refine the profiler layout for current activity,
   nested timing rows, and top time sinks without changing monitor API shape.
4. Action and link clarity: improve Human Action and Links visibility while
   continuing to show only sanitized, bounded monitor data.
5. Mode proof: add or refresh smoke proof for browser read-only mode and
   standalone Dock mode after UI changes land.

## Do Not Break

- App launch: `agent-os monitor install-macos --repo <repo> --workflow
  <workflow> --port <port>` must keep generating a Dock-runnable
  `AgentOS Monitor.app` that opens a standalone Electron window.
- Config path: the default launcher config remains
  `~/Library/Application Support/AgentOS Monitor/config.json`.
- Command and config: `LauncherConfig` continues to store `repo`, `workflow`,
  fixed `host: "127.0.0.1"`, `port`, and optional `command`. Preserve
  `LauncherConfig.command`; when present, it remains the command override used
  to start AgentOS. Without it, the launcher uses `bin/agent-os`.
- Health wait: standalone launch continues to wait for
  `GET /api/monitor/v1/health` before reporting `running`; an already healthy
  configured endpoint remains an externally managed `attached` state.
- Start and Stop ownership: Start may spawn only the configured local command
  when the configured port is free. Stop may terminate only the child process
  started by the launcher, using graceful shutdown before escalation. Attached
  external daemons are never stopped by the app.
- App close behavior: closing the standalone window exits the Electron shell
  only. It must not stop a launcher-owned AgentOS process; Stop remains the
  explicit path for that.
- Browser versus standalone behavior: browser mode stays read-only, has no
  Start or Stop controls, and only reads the existing monitor endpoint.
  Standalone mode may show launcher status and controls, then loads the same
  profiler with `?mode=standalone`.
- Current Dock behavior: the generated app keeps the installed node path,
  Homebrew paths, nvm loading, repo-local Electron, global Electron,
  `npx --yes electron@35.7.5`, and `AGENTOS_MONITOR_ELECTRON` fallback behavior
  that make Dock launch work without shell startup files.

## Out Of Scope

- Adding monitor mutation endpoints such as start, stop, restart, refresh, or
  scheduler control routes.
- Changing the read-only `/api/monitor/v1/snapshot`,
  `/api/monitor/v1/stream`, or `/api/monitor/v1/health` API contract.
- Serving raw logs, raw diffs, prompts, model responses, full runner payloads,
  secrets, environment values, or raw rate-limit payloads through the monitor.
- Changing `LauncherConfig.command`, the default config path, Dock installation
  path, or process ownership semantics.
- Replacing Linear, validation evidence, PR metadata, handoff files, or run
  artifacts as the source of truth.
- Adding Windows or Linux standalone launchers in this optimization slice.
