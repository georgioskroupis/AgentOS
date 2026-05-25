# Orchestrator Responsibilities

This map records current responsibilities before any orchestrator refactor. It
is a planning artifact, not a request to move code immediately. Classifications
come from `docs/architecture/SOURCE_FAITHFUL_CORE.md`.

| Responsibility | Current owner | Classification | Boundary expectation |
| --- | --- | --- | --- |
| Workflow loading and strict config validation | `src/workflow.ts` | `source-core` | Core config boundary; orchestration consumes resolved config |
| Tracker polling and eligibility | `src/orchestrator.ts`, `src/orchestrator-tracker-guard.ts`, `src/tracker-boundaries.ts` | `source-core` | Core scheduler reads normalized tracker state before dispatch; tracker adapters beyond Linear remain extensions |
| Dependency and active-state guardrails | `src/orchestrator-tracker-guard.ts` | `source-core` | Core scheduler; no runner side effects before guardrails pass |
| Agent-owned lifecycle events and repo-local writes | `src/orchestrator.ts`, `src/lifecycle-controller.ts`, `src/orchestrator-lifecycle-comments.ts`, `src/lifecycle-events.ts`, `src/agent-lifecycle.ts`, `scripts/agent-linear-*.sh` | `source-core` | Default lifecycle progress is agent-owned through repo-local tools; the thin lifecycle controller rejects normal scheduler writes in `agent-owned` and only allows enumerated `scheduler_safety` writes when no agent can act |
| Workspace creation and bootstrap failure handling | `src/workspace.ts`, `src/orchestrator-workspace-bootstrap.ts` | `source-core` | Core workspace lifecycle; hooks run from created workspaces |
| Runner invocation and event capture | `src/orchestrator.ts`, `src/runner/app-server.ts` | `source-core` | Runner protocol stays below orchestration policy |
| Lean monitor event contract | `src/monitor-contracts.ts` | `source-core` | Core may emit dependency-free monitor events through `MonitorSink`; it must not assemble snapshots or import launcher/UI contracts |
| Agent-owned lifecycle evidence verification | `src/agent-owned-lifecycle-evidence.ts`, `src/orchestrator.ts`, `src/runs.ts`, `src/issue-state.ts` | `source-core` | Core verification for agent-owned mode; missing tracker evidence becomes local `human_required` state and does not trigger scheduler duplication of normal lifecycle writes |
| Validation evidence and validation budget | `src/agent-owned-lifecycle-evidence.ts`, `src/validation.ts`, `src/validation-profile.ts`, `src/orchestrator-validation.ts`, `src/orchestrator.ts`, `src/issue-state.ts` | `source-core` | Handoff evidence must verify before review, and unchanged-head full validation reuse is explicit and profile-bound |
| Context-budget safety stops | `src/context-budget.ts`, `src/context-pack.ts` | `source-core` | Budget diagnostics and stops protect core implementation/re-entry prompts unless later proven extension-only |
| GitHub PR URL validation in handoff | `src/agent-lifecycle.ts`, `src/agent-owned-lifecycle-evidence.ts`, `src/issue-state.ts` | `source-core` | PR metadata must be current-repository GitHub pull request URLs before local state or tracker updates |
| Retry and durable recovery | `src/orchestrator.ts`, `src/runtime-state.ts`, `src/recovery.ts` | `source-core` | Core recovery; terminal and inactive issues must not redispatch |
| Implementation audit and no-PR handoff outcomes | `WORKFLOW.md`, `templates/base-harness/WORKFLOW.md`, `src/issue-state.ts` | `source-core` | Issues are the unit of work; already-satisfied, investigation, planning, and no-PR handoffs remain valid |
| Review and fixer loop | `src/orchestrator.ts`, `src/reviewer-runner.ts`, `src/review.ts` | `extension` | Source-aligned extension of the core loop, bounded by review policy |
| Review budget and split recommendation | `src/review-budget.ts`, `src/review-budget-orchestration.ts` | `extension` | Optional review/fixer governance; separate from core validation budget |
| CI diagnostics and repair | `src/github.ts`, `src/ci-diagnostics.ts`, `src/ci-retry.ts`, `src/orchestrator-ci-retry.ts` | `extension` | Mechanical repair only when diagnostics are trustworthy and bounded |
| GitHub status, checks, readiness, merge, and cleanup | `src/github.ts`, `src/landing-policy.ts`, `src/orchestrator-landing-preflight.ts`, `src/orchestrator-pr-ready.ts`, `src/orchestrator-branch-update.ts`, `src/orchestrator-merge-cleanup.ts` | `extension` | GitHub behavior beyond PR URL validation is optional and high-trust where it can mutate branches or merge |
| Merge shepherding | `src/orchestrator.ts`, `src/github.ts`, `src/landing-policy.ts` | `extension` | High-trust extension, not public-template default |
| Scope scoring and planning/decomposition helpers | `src/scope-report.ts`, `src/scope-report-scoring.ts`, `src/linear-planned-issues.ts`, `scripts/agent-linear-plan-issues.sh` | `extension` | Core may stop unsafe broad dispatch; issue creation and decomposition helpers remain optional planning behavior |
| Monitor placeholder listener | `src/http-server.ts`, `dashboard/` | `extension` | Optional observability extension; not a scheduler control plane |
| Lean monitor snapshot, reducer, and launcher | `src/monitor-extension-contracts.ts`, `src/monitor-aggregator.ts`, `docs/architecture/LEAN_MONITOR_CONTRACT.md`, `docs/architecture/MONITOR_DELETION_MANIFEST.md` | `extension` | Snapshot assembly, timing reduction, browser UI, standalone Mac launcher, and removed dashboard/API touchpoints stay outside source-core orchestration |
| Registry-wide scheduling | `src/registry-orchestrator.ts`, `src/registry.ts` | `extension` | Optional extension over project-local orchestration |
| Model routing | `src/model-routing.ts` | `extension` | Report-only optimization by default; not source-core execution policy |
| Linear writes, tracker tools, and raw GraphQL | `src/linear.ts`, `src/lifecycle-controller.ts`, `src/agent-lifecycle.ts`, `src/cli-linear-helpers.ts`, `src/tracker-boundaries.ts`, `src/runner/client-tools.ts` | `source-core` plus `extension` | Linear lifecycle wrappers are core; raw GraphQL and tracker adapters beyond Linear are optional extension behavior |
| Deterministic PR creation helper | `scripts/agent-create-pr.sh`, `templates/base-harness/scripts/agent-create-pr.sh` | `harness extension` | Non-interactive PR helper for PR-producing handoffs; not required for no-PR or already-satisfied outcomes |
| Root high-throughput workflow posture | `WORKFLOW.md` | `dogfood-only` | Root danger/high-throughput settings exercise trusted internal automation; public templates stay conservative |

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
