# Source-Faithful Core Contract

This contract defines the smallest AgentOS behavior set that counts as
source-faithful core. It is the reference for later architecture checks and
module mapping. A module can ship in this repository without being core.
The machine-readable module map lives in
`docs/architecture/source-module-map.json`; `npm run check:architecture`
uses it to reject source-core imports of concrete extension implementations
while allowing imports of explicit extension interfaces.

## Classifications

| Classification | Meaning |
| --- | --- |
| `source-core` | Required for conservative, source-faithful AgentOS operation and certification. Public templates may depend on this behavior. |
| `extension` | Useful behavior that must stay explicitly optional, gated, or outside core certification. Extensions may ship here, but core must not depend on them. |
| `harness extension` | Repo-local helper behavior copied with the harness for agent ergonomics. It supports core workflows but is not required scheduler policy. |
| `dogfood-only` | Trusted internal posture used by the AgentOS root workflow to exercise high-throughput paths. It is intentionally not the public template default. |

## Source-Core Surfaces

| Surface | Primary files | Core contract |
| --- | --- | --- |
| Workflow loading and strict validation | `src/workflow.ts`, `WORKFLOW.md`, `templates/base-harness/WORKFLOW.md` | Resolve one workflow file, validate configured lifecycle/tracker/runner policy, and keep public defaults conservative. |
| Agent-owned lifecycle policy | `src/lifecycle.ts`, `src/lifecycle-events.ts`, `src/lifecycle-controller.ts`, `src/agent-lifecycle.ts`, `scripts/agent-linear-*.sh` | `agent-owned` is the only public source-faithful lifecycle mode. Normal lifecycle writes go through repo-local tools with issue/run/attempt markers. Scheduler writes are limited to enumerated `scheduler_safety` reasons. |
| Tracker read boundary, scheduler-safety writer, and Linear default | `src/tracker-boundaries.ts`, `src/tracker-adapters.ts`, `src/linear.ts`, `src/orchestrator-tracker-guard.ts` | Core orchestration reads normalized issue state and eligibility through `TrackerReader`, and receives tracker writes only through the explicit `SchedulerSafetyWriter` capability for enumerated safety cases. Linear is the production default. Additional tracker adapters are extensions. |
| Workspace lifecycle | `src/workspace.ts`, `src/orchestrator-workspace-bootstrap.ts`, `scripts/agent-bootstrap-worktree.sh` | Create deterministic issue workspaces, run bootstrap hooks from the workspace, and fail partial bootstrap explicitly instead of silently reusing it. |
| Runner invocation boundary | `src/runner/app-server.ts`, `src/orchestrator.ts`, `src/runs.ts` | Start and observe Codex App Server runs, capture events, and classify dead or stalled turns without embedding tracker or GitHub policy in the runner. |
| Dispatch, retry, recovery, and terminal reconciliation | `src/orchestrator.ts`, `src/runtime-state.ts`, `src/recovery.ts`, `src/orchestrator-terminal.ts` | Dispatch eligible issues once, persist active/retry state, recover stale runtime safely, suppress duplicate successful unchanged work, and respect terminal truth. |
| Implementation audit and handoff outcomes | `WORKFLOW.md`, `templates/base-harness/WORKFLOW.md`, `src/issue-state.ts`, `src/orchestrator-agent-owned-evidence.ts` | Agent turns must classify work as `already-satisfied`, `partially-satisfied`, or `implemented`; no-op handoffs are valid and PRs are optional outputs. |
| Handoff validation evidence | `src/agent-owned-lifecycle-evidence.ts`, `src/issue-state.ts`, `WORKFLOW.md` | A handoff is reviewable only after its `Validation-JSON` evidence verifies. Evidence records issue id, run id, repo head, reuse profile, status, and command attempts. |
| Post-validation extension boundary | `src/post-validation-extension.ts`, `src/orchestrator.ts` | After successful handoff validation and agent-owned evidence checks, source-core orchestration calls a typed post-validation extension. The source-core-safe implementation is a no-op that returns the validated issue state. |
| Merge-state extension boundary | `src/merge-state-extension.ts`, `src/orchestrator.ts` | Source-core orchestration calls a typed merge-state extension after retry/reconciliation setup. The source-core-safe implementation is a no-op, so source-core certification can pass without fetching or processing `Merging` issues. |
| Validation budget | `src/workflow.ts`, `src/validation.ts`, `src/validation-profile.ts`, `src/orchestrator-validation.ts`, `WORKFLOW.md` | Full-suite proof is budgeted per unchanged head and may be reused only when head, workflow hash, trust mode, automation profile, repair policy, and risk profile still match. |
| Context-budget safety stops | `src/context-budget.ts`, `src/context-pack.ts`, `WORKFLOW.md` | Prompt size diagnostics and per-turn/cumulative budget stops are source-core safety behavior unless a later source audit proves a specific part is extension-only. |
| Lean monitor event contract | `src/monitor-contracts.ts` | Source-core code may emit monitor events through a dependency-free sink contract. Snapshot assembly, UI rendering, and launcher behavior remain extension-owned. |
| GitHub PR URL validation in handoff | `src/agent-lifecycle.ts`, `src/agent-owned-lifecycle-evidence.ts`, `src/issue-state.ts` | When a handoff or lifecycle tool records PR metadata, URLs must point to GitHub pull requests in the current repository before state is stored or tracker updates are posted. |
| Status and inspect evidence reads | `src/status.ts`, `src/status-diagnostics.ts`, `src/cli.ts` | Operators can inspect durable issue/run state, validation evidence, handoffs, retry state, and next safe actions without starting orchestration. |

## Extension Surfaces

These surfaces are explicitly non-core. They may be tested, documented, and
useful, but source-core certification must not require them.

| Surface | Primary files | Boundary |
| --- | --- | --- |
| Review and fixer loop | `src/post-validation-review-adapter.ts`, `src/reviewer-runner.ts`, `src/reviewer-scheduler.ts`, `src/review.ts` | Extension over core handoff. Blocking findings and fixer turns must not become a prerequisite for source-core dispatch or handoff verification; dogfood routes them through the post-validation adapter. |
| Review budget and split recommendation | `src/review-budget.ts`, `src/review-budget-orchestration.ts` | Extension policy that recommends or blocks broad review/fix loops according to review config. Not core validation budgeting. |
| CI diagnostics and repair | `src/ci-diagnostics.ts`, `src/ci-retry.ts`, `src/orchestrator-ci-retry.ts`, `src/post-validation-review-adapter.ts` | Mechanical repair extension for trustworthy logs and permitted PR/network access. Core can report failed validation without repairing CI. |
| GitHub PR status, checks, readiness, branch update, merge, and cleanup | `src/github.ts`, `src/landing-policy.ts`, `src/orchestrator-landing-preflight.ts`, `src/orchestrator-pr-ready.ts`, `src/orchestrator-branch-update.ts`, `src/orchestrator-merge-cleanup.ts` | GitHub lifecycle beyond current-repo PR URL validation is extension behavior, with merge shepherding a high-trust extension. |
| Merge shepherd | `src/merge-state-shepherd-adapter.ts`, `src/orchestrator.ts`, `src/github.ts`, `src/landing-policy.ts` | High-trust extension for `Merging` issues; the adapter preserves current dogfood behavior while the source-core boundary can use the no-op merge-state implementation. |
| Monitor read-only listener | `src/http-server.ts`, `dashboard/` | Optional observability extension. It serves the lean monitor shell plus snapshot, SSE stream, and tiny health routes, and must not become a scheduler control plane. |
| Lean monitor snapshot, reducer, and launcher | `src/monitor-extension-contracts.ts`, `src/monitor-aggregator.ts`, `docs/architecture/LEAN_MONITOR_CONTRACT.md`, `docs/architecture/MONITOR_DELETION_MANIFEST.md` | Optional observability extension over source-core monitor events. Snapshot assembly, timing reduction, UI sections, timing rows, top sinks, human action rendering, browser mode, and standalone Mac launcher behavior must not become source-core scheduler policy. |
| Registry-wide orchestration | `src/registry.ts`, `src/registry-orchestrator.ts` | Optional coordinator over project-local workflows. Core remains single-project orchestration. |
| Model routing | `src/model-routing.ts` | Optimization/observability extension. Report-only routing is not required for source-core operation. |
| Tracker adapters beyond Linear | `src/tracker-adapters.ts` plus adapter modules | Extension surface. New adapters must satisfy the tracker boundary without changing core lifecycle policy. |
| Raw GraphQL and `linear_graphql` client tool | `src/runner/client-tools.ts`, Linear GraphQL helpers | Experimental extension available only with explicit workflow opt-in. Agent-owned core uses repo-local lifecycle tools instead. |
| Planning and decomposition helpers | `src/linear-planned-issue-types.ts`, `src/linear-planned-issues.ts`, `src/scope-report-scoring.ts`, `scripts/agent-linear-plan-issues.sh` | Planning/decomposition output and child/follow-up issue creation are extensions behind `PlanningIssueWriter`. Core may stop broad unsafe dispatch, but it does not need to create decomposition issues. |
| Deterministic PR creation helper | `scripts/agent-create-pr.sh`, `templates/base-harness/scripts/agent-create-pr.sh` | Harness extension for non-interactive PR publication. It supports agent handoffs when a PR is needed, but issues and handoffs are valid without PRs. |

## Dogfood-Only Root Posture

The repository root `WORKFLOW.md` is intentionally stronger than the public
template. It uses `trust_mode: danger`, `automation.profile: high-throughput`,
`automation.repair_policy: mechanical-first`, parallel reviewers,
high-throughput landing gates, and merge shepherding so AgentOS can dogfood
trusted internal automation.

The public base template remains conservative: `trust_mode: ci-locked`,
`automation.profile: conservative`, manual merge mode, no automatic draft-ready
promotion, and lower review parallelism. Architecture checks should treat root
dogfood configuration as `dogfood-only`, not as evidence that public templates
must enable the same extension behavior.

## Mapping Rule

When adding or moving modules, classify the behavior before wiring it into
core paths. If a `source-core` module imports an `extension` implementation,
the import must be an explicit boundary adapter or the responsibility map must
be updated before the code moves. If a surface is not listed here, treat it as
non-core until this contract is updated.
