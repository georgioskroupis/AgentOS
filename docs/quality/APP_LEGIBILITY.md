# Application Legibility

Each harnessed project should make runtime behavior inspectable without
requiring a human to narrate what happened.

## Project Checklist

Fill in the applicable commands, paths, or URLs for the target project:

| Item | Project value |
| --- | --- |
| Start command | `AGENT_APP_START_COMMAND=` |
| Health check | `AGENT_HEALTH_CHECK_COMMAND=` |
| Smoke test | `AGENT_SMOKE_COMMAND=` or `./scripts/agent-smoke-test.sh` |
| Log capture | `AGENT_LOG_PATHS=` or `./scripts/agent-capture-logs.sh` |
| Metrics access | `AGENT_METRICS_COMMAND=` or link to local dashboard/query |
| Trace access | `AGENT_TRACES_COMMAND=` or link to local trace view |
| CI log access | `AGENT_CI_LOG_COMMAND=` or `gh run view --log` command |
| UI screenshot/video proof | `AGENT_PROOF_SCREENSHOT_COMMAND=` when UI is present |
| Browser/DOM inspection | `AGENT_PROOF_DOM_COMMAND=` when browser inspection applies |

## Standard Scripts

- `scripts/agent-start-app.sh` starts the app and writes a PID/log under
  `.agent-os/runs/`.
- `scripts/agent-smoke-test.sh` runs the configured smoke check or common test
  command.
- `scripts/agent-capture-logs.sh` indexes project logs for handoff evidence.
- `scripts/agent-capture-proof.sh` writes `.agent-os/proof/latest-proof.md`
  and runs optional health, metrics, trace, CI, UI, and DOM capture commands.

Keep the default checks lightweight. Projects can opt into screenshots, traces,
videos, or dashboard queries by setting the corresponding environment variable
or documenting the command in this file.

