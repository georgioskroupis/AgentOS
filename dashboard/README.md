# AgentOS Monitor

Static Lean Live Work Profiler for the optional AgentOS local monitor listener.
Linear remains the control plane. The page is read-only in browser mode and
renders `MonitorSnapshot` data from `/api/monitor/v1/snapshot` plus live
`monitor_snapshot` events from `/api/monitor/v1/stream`.

## Start

```bash
bin/agent-os orchestrator run --repo . --workflow WORKFLOW.md --port 4317
open http://127.0.0.1:4317/
```

`server.port` in `WORKFLOW.md` can also enable the same local listener without
passing `--port`. The host defaults to `127.0.0.1`.

## Route

- `GET /`

The dashboard has no build step, no package manager, and no CDN dependency. It
is a static `index.html` served by the AgentOS monitor root route. Browser mode
does not render mutation controls. Standalone mode can be previewed with
`/?mode=standalone`; it adds only the launcher status strip outside the seven
profiler sections.

## Local Helper

```bash
./dashboard/serve.sh 4317
```

The helper starts the normal AgentOS orchestrator with the monitor listener enabled.
