# AgentOS Monitor

Static lean monitor shell for the optional AgentOS local monitor listener.
Linear remains the control plane. Runtime snapshot rendering is intentionally
not implemented in this slice.

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
is a static `index.html` served by the AgentOS monitor root route.

## Local Helper

```bash
./dashboard/serve.sh 4317
```

The helper starts the normal AgentOS orchestrator with the HTTP API enabled.
