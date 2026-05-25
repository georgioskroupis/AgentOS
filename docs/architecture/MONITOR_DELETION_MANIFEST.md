# Monitor Deletion Manifest

This manifest inventories legacy monitor/dashboard touchpoints before runtime
code moves. VER-150 does not delete or replace runtime code; later monitor
slices should use this table as the source of truth for removal and migration.

## Forbidden Legacy Terms For Future Checks

- `POST /api/v1/refresh`
- `/api/v1/refresh`
- `/api/v1/state`
- old monitor issue-route pattern
- `onRefresh`
- `.live`
- `legacy dashboard`
- `browser-side state reconstruction`

Forbidden-term checks must allowlist this manifest, historical docs when they
are intentionally retained, and the check implementation itself.

## Inventory

| File | Legacy concept found | Delete / Replace / Keep | Reason |
| --- | --- | --- | --- |
| `dashboard/index.html` | `AgentOS Monitor`, `refresh`, `/api/v1/state`, `/api/v1/refresh` | Replace | Legacy browser dashboard reconstructs operator state from HTTP API responses; future UI should render `MonitorSnapshot`. |
| `dashboard/README.md` | `dashboard`, `--port`, `server.port`, `/api/v1/state`, `/api/v1/<issue>`, `POST /api/v1/refresh` | Replace | Documents the legacy loopback dashboard/API contract; keep only as historical context until runtime replacement. |
| `dashboard/.gitignore` | `.live` | Delete | Local snapshot directory belongs to the old dashboard helper and is not part of the lean monitor contract. |
| `dashboard/serve.sh` | `--port` | Replace | Helper launches the legacy loopback HTTP dashboard instead of the standalone Mac launcher boundary. |
| `src/http-server.ts` | `http-server`, `onRefresh`, `refresh`, `/api/v1/state`, `/api/v1/refresh`, old monitor issue-route pattern | Replace | Owns the legacy loopback HTTP API and browser shell fallback; later work should replace it with snapshot serving owned by the monitor extension. |
| `src/http-server-cli.ts` | `http-server`, `onRefresh` | Replace | Wires orchestrator refresh callbacks into the legacy HTTP server. |
| `src/cli.ts` | `--port`, `onRefresh`, `refresh` | Replace | CLI exposes the old loopback API launcher path for `orchestrator once` and `orchestrator run`. |
| `src/workflow.ts` | `server.port`, daemon refresh interval | Keep | `server.port` is legacy monitor configuration to replace later; daemon freshness refresh is unrelated runtime health behavior. |
| `src/types.ts` | `server.port` | Keep | Existing workflow config typing is still required until the legacy API is removed. |
| `src/orchestrator.ts` and focused orchestrator helpers | `refresh` | Keep | Most refresh references are GitHub, Linear, daemon, validation, or artifact freshness behavior unrelated to the legacy monitor. |
| `src/daemon-freshness.ts`, `src/orchestrator-daemon-runtime.ts`, `src/status-validation.ts`, `src/runs.ts`, `src/phase-timing.ts` | `refresh` | Keep | These are durable-state or freshness operations, not monitor UI refresh controls. |
| `WORKFLOW.md` | `server.port`, `--port`, `/api/v1/state`, `/api/v1/<issue>`, `POST /api/v1/refresh`, `dashboard`, `refresh` | Replace | Root workflow still documents the legacy optional loopback API; update when runtime replacement lands. |
| `ARCHITECTURE.md` | `dashboard` | Keep | Architecture boundary wording remains useful; update the referenced surface after replacement. |
| `README.md` | `refresh` | Keep | Maintenance issue wording is not a monitor UI contract. |
| `docs/architecture/AGENT_OS.md` | `server.port`, `--port`, `/api/v1/state`, `/api/v1/<issue>`, `POST /api/v1/refresh`, `dashboard` | Replace | Historical architecture doc for the legacy optional HTTP dashboard/API. |
| `docs/architecture/ORCHESTRATOR_RESPONSIBILITIES.md` | `dashboard`, `http-server` | Replace | Responsibility map should point to the lean monitor extension once runtime code moves. |
| `docs/architecture/SOURCE_FAITHFUL_CORE.md` | `dashboard` | Keep | Extension classification remains correct; this doc now distinguishes lean monitor contracts from legacy dashboard/API runtime. |
| `docs/decisions/0002-optional-extension-boundaries.md` | `dashboard` | Keep | Historical extension-boundary decision remains valid. |
| `docs/planning/SOURCE_ALIGNMENT_AUDIT.md` | `dashboard`, `refresh` | Keep | Historical planning/audit material; do not rewrite unless the planning source changes. |
| `docs/quality/APP_LEGIBILITY.md` and `templates/base-harness/docs/quality/APP_LEGIBILITY.md` | `dashboard` | Keep | Generic application-legibility guidance, not the AgentOS monitor implementation. |
| `docs/quality/QUALITY_SCORE.md` and `templates/base-harness/docs/quality/QUALITY_SCORE.md` | `Monitor automation health`, `refresh` | Keep | Maintenance-health rubric, not a UI monitor contract. |
| `docs/quality/TEST_SUITE.md` | `refresh` | Keep | Test inventory language for existing freshness tests. |
| `docs/releases/*` | `dashboard`, `/api/v1/*`, `refresh`, `legacy` | Keep | Historical release and certification records. |
| `docs/runbooks/LINEAR_SETUP.md`, `docs/runbooks/DOGFOODING.md`, `docs/runbooks/GITHUB_CI.md` | `monitoring`, `refresh`, `legacy` | Keep | Operational or historical wording unrelated to the lean monitor contract. |
| `scripts/check-dashboard.mjs` | `dashboard`, legacy endpoint checks | Replace | Check should validate the lean monitor contract and manifest until runtime replacement changes the dashboard. |
| `scripts/agent-check.sh` | `dashboard`, `check:dashboard` | Keep | Harness phase name remains the validation entrypoint for this extension. |
| `scripts/check-docs.mjs`, `scripts/check-traceability.mjs`, `scripts/check-harness-contract.mjs` | `dashboard`, `server.port`, `legacy` | Keep | Meta-checks must continue to inspect docs, traceability, and public template defaults. |
| `tests/http-server.test.ts` | `/api/v1/state`, `/api/v1/refresh`, `refresh` | Replace | Tests the legacy loopback API and should move to snapshot-serving behavior with the runtime replacement. |
| `tests/workflow.test.ts` | `server.port`, legacy lifecycle wording | Keep | `server.port` assertions remain until workflow config removes legacy API support; lifecycle legacy checks are unrelated. |
| `tests/check-scripts.test.ts`, `tests/orchestrator.test.ts`, `tests/runs.test.ts`, `tests/issue-state.test.ts`, `tests/github.test.ts` | `dashboard`, `refresh`, `legacy` | Keep | Existing test names and fixtures cover non-monitor behavior or historical compatibility. |
| `templates/maintenance/quality-score-refresh.md` | `refresh`, `monitor automation health` | Keep | Maintenance template naming is not a legacy monitor UI contract. |
| `templates/base-harness/WORKFLOW.md` | daemon refresh interval | Keep | Public template has no monitor API enablement by default; daemon freshness is unrelated. |
