# Orchestrator Responsibilities

This map records current responsibilities before any orchestrator refactor. It
is a planning artifact, not a request to move code immediately.

| Responsibility | Current owner | Boundary expectation |
| --- | --- | --- |
| Workflow loading and strict config validation | `src/workflow.ts` | Core config boundary; orchestration consumes resolved config |
| Tracker polling and eligibility | `src/orchestrator.ts`, `src/orchestrator-tracker-guard.ts` | Core scheduler reads tracker state before dispatch |
| Dependency and active-state guardrails | `src/orchestrator-tracker-guard.ts` | Core scheduler; no runner side effects before guardrails pass |
| Claiming and lifecycle comments | `src/orchestrator.ts`, `src/lifecycle-controller.ts`, `src/orchestrator-lifecycle-comments.ts`, `src/lifecycle-events.ts` | Core scheduler emits lifecycle events; the thin lifecycle controller routes existing compatibility tracker writes until agent-owned tooling becomes the default |
| Workspace creation and bootstrap failure handling | `src/workspace.ts`, `src/orchestrator-workspace-bootstrap.ts` | Core workspace lifecycle; hooks run from created workspaces |
| Runner invocation and event capture | `src/orchestrator.ts`, `src/runner/app-server.ts` | Runner protocol stays below orchestration policy |
| Retry and durable recovery | `src/orchestrator.ts`, `src/runtime-state.ts`, `src/recovery.ts` | Core recovery; terminal and inactive issues must not redispatch |
| Review and fixer loop | `src/orchestrator.ts`, `src/reviewer-runner.ts`, `src/review.ts` | Source-aligned extension of the core loop, bounded by review policy |
| CI diagnostics and repair | `src/github.ts`, `src/ci-retry.ts`, `src/orchestrator-ci-retry.ts` | Mechanical repair only when diagnostics are trustworthy and bounded |
| Merge shepherding | `src/orchestrator.ts`, `src/github.ts`, `src/landing-policy.ts` | High-trust extension, not public-template default |
| Scope scoring and planning guardrails | `src/scope-report.ts`, `src/scope-report-scoring.ts` | Planning aid; should pause broad work rather than expand implementation |
| Dashboard/API state | `src/http-server.ts`, `dashboard/` | Optional observability extension; not a scheduler control plane |
| Registry-wide scheduling | `src/registry-orchestrator.ts`, `src/registry.ts` | Optional extension over project-local orchestration |
| Linear writes and tracker tools | `src/linear.ts`, `src/lifecycle-controller.ts`, `src/agent-lifecycle.ts`, `src/cli-linear-helpers.ts`, `src/tracker-boundaries.ts` | Tracker read/write capabilities are split at the type boundary; the lifecycle controller only routes event-backed compatibility writes, and normal lifecycle writes are productionized behind repo-local agent-owned tools before the default flip |

## Refactor Guardrails

- Do not move behavior out of `src/orchestrator.ts` unless the receiving module
  has a clear single responsibility and existing tests still cover the boundary.
- Keep runner, tracker, GitHub, and status modules free of orchestration
  ownership decisions unless explicitly listed here.
- Direct tracker lifecycle writes from core scheduler code are forbidden.
  `npm run check:architecture` fails direct `move`, `comment`, or
  `upsertComment` calls in `src/orchestrator.ts`, including old compatibility
  helper paths. The orchestrator may emit lifecycle events; it must not perform
  tracker writes itself.
- `src/lifecycle-controller.ts` must stay thin. It may route lifecycle events
  to tracker capabilities and preserve existing compatibility behavior, but it
  must not import review, merge, CI repair, dashboard, registry, model-routing,
  tracker-adapter, raw Linear, or human-decision policy implementations.
- Update this map before broadening dashboard, registry, merge, or tracker-tool
  responsibilities.
