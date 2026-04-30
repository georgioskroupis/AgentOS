---
name: qa-smoke-test
description: Use when a task needs end-to-end, smoke, UI, API, log, or runtime validation beyond unit tests.
---

# QA Smoke Test Workflow

1. Start the app or service using the repo's agent-local script when available.
2. Run `./scripts/agent-smoke-test.sh` when present.
3. Capture useful logs with `./scripts/agent-capture-logs.sh` when present.
4. For UI work, prefer browser-driven validation with screenshots or video
   evidence when the project profile supports it.
5. For API work, validate health checks, key contracts, and failure responses.
6. Record what was exercised, artifacts produced, and any untested risk in the
   handoff.
