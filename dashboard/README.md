# AgentOS Monitor

Read-only operator dashboard for the optional AgentOS loopback HTTP API.
Linear remains the control plane; this surface watches durable daemon, issue,
run, retry, token, and rate-limit state exposed by the running orchestrator.

## Start

```bash
bin/agent-os orchestrator run --repo . --workflow WORKFLOW.md --port 4317
open http://127.0.0.1:4317/
```

`server.port` in `WORKFLOW.md` can also enable the same API without passing
`--port`. The host defaults to `127.0.0.1`.

## API Used

- `GET /api/v1/state`
- `GET /api/v1/<issue>`
- `POST /api/v1/refresh`

The dashboard has no build step, no package manager, and no CDN dependency. It
is a static `index.html` served by the AgentOS HTTP API root route.

## Local Helper

```bash
./dashboard/serve.sh 4317
```

The helper starts the normal AgentOS orchestrator with the HTTP API enabled.
