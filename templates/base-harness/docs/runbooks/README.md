# Runbooks

Put repeatable operational procedures here.

Good runbooks include:

- prerequisites
- commands to run
- expected output
- rollback or failure behavior

## AgentOS Daemon Environment

If this repo is run by the AgentOS daemon, store restart-safe local environment
in `.agent-os/env` when needed:

```bash
LINEAR_API_KEY=lin_...
AGENT_OS_SOURCE_REPO=/path/to/agent-os
```

The daemon loads this file before resolving `WORKFLOW.md`, reports whether it is
missing, malformed, stale, or loaded, and refuses to dispatch when required
credentials are unavailable.
