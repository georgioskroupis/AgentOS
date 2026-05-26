# AgentOS Monitor

Static Lean Live Work Profiler for the optional AgentOS local monitor listener.
Linear remains the control plane. The page is read-only in browser mode and
renders `MonitorSnapshot` data from `/api/monitor/v1/snapshot` plus live
`monitor_snapshot` events from `/api/monitor/v1/stream`.

## Start

Browser mode is for an already-running AgentOS monitor listener:

```bash
bin/agent-os orchestrator run --repo . --workflow WORKFLOW.md --port 4317
open http://127.0.0.1:4317/
```

`server.port` in `WORKFLOW.md` can also enable the same local listener without
passing `--port`. The host defaults to `127.0.0.1`. Browser mode is read-only:
it renders the profiler and exposes no Start or Stop controls.

## Route

- `GET /`

The dashboard has no build step, no package manager, and no CDN dependency. It
is a static `index.html` served by the AgentOS monitor root route. Browser mode
does not render mutation controls. Standalone mode can be previewed with
`/?mode=standalone`; it adds only the launcher status strip outside the seven
profiler sections.

## macOS Dock App

Install or update the standalone app bundle with:

```bash
bin/agent-os monitor install-macos --repo . --workflow WORKFLOW.md --port 4317
```

The command writes
`~/Library/Application Support/AgentOS Monitor/config.json` and creates
`~/Applications/AgentOS Monitor.app` by default. Drag the generated app into the
Dock, or open it once and choose Options > Keep in Dock. Closing the standalone
window exits only the Electron shell; a launcher-owned AgentOS process keeps
running until Stop is pressed.

When the app opens and no monitor health endpoint is available, it starts the
configured `bin/agent-os orchestrator run --repo <repo> --workflow <workflow>
--port <port>` command and marks that process as launcher-owned. In that state
Stop sends the documented shutdown signals to only that child process.

When the configured port already has a healthy AgentOS monitor endpoint, the app
attaches in read-only externally managed mode. Start is not needed, Stop is
disabled, and closing the standalone window leaves the external AgentOS process
running.

## Local Helper

```bash
./dashboard/serve.sh 4317
```

The helper starts the normal AgentOS orchestrator with the monitor listener enabled.
