# Decision 0002: Optional Extension Boundaries

## Context

AgentOS implements the Harness Engineering and Symphony core, then layers local
operator conveniences on top. Symphony treats a rich web UI/control plane and
general workflow engine behavior as non-goals for the core scheduler, so
extension surfaces need to stay visible and opt-in.

## Decision

Classify the main surfaces as follows. The detailed module-mapping contract is
`docs/architecture/SOURCE_FAITHFUL_CORE.md`.

| Surface | Classification |
| --- | --- |
| Workflow loader and strict validator | `source-core` |
| Workspace manager and workspace hooks | `source-core` |
| Tracker reader, issue eligibility, and Linear default | `source-core` |
| Codex runner boundary | `source-core` |
| Orchestrator dispatch, retry, durable recovery, and terminal reconciliation | `source-core` |
| Agent-owned lifecycle tools, marker validation, allowed transitions, and scheduler-safety write limits | `source-core` |
| Implementation audit and no-PR handoff outcomes | `source-core` |
| Handoff validation evidence | `source-core` |
| Validation budget and unchanged-head evidence reuse | `source-core` |
| Context-budget safety stops | `source-core` unless later proven extension-only |
| GitHub PR URL validation in handoff and lifecycle metadata | `source-core` |
| Status and inspect CLI evidence reads | `source-core` |
| Review and fixer loop | `extension` |
| Review budget and split/follow-up recommendation | `extension` |
| CI diagnostics and repair | `extension` |
| GitHub PR status, checks, readiness, branch update, merge, and cleanup behavior | `extension` |
| Merge shepherd | High-trust `extension` |
| Dashboard/API | Optional `extension` |
| Registry-wide orchestration | Optional `extension` |
| Model routing | Optimization `extension` |
| Tracker adapters beyond Linear | `extension` |
| Raw GraphQL and `linear_graphql` client tool | Experimental `extension` |
| Planning/decomposition helpers and child/follow-up issue creation | `extension` |
| Deterministic PR creation helpers | `harness extension` |
| Root `WORKFLOW.md` danger/high-throughput posture | `dogfood-only` |

Core surfaces must remain conservative and source-faithful by default.
Extensions may ship in this repository, but their docs, config gates, and tests
must preserve the boundary. The root AgentOS workflow may dogfood trusted
high-throughput extension behavior; `templates/base-harness/WORKFLOW.md` remains
the public conservative default.

## Consequences

- Public templates keep conservative defaults.
- Dashboard/API and registry behavior must not become required for ordinary
  single-project orchestration.
- High-throughput merge behavior stays behind explicit trust, automation, and
  merge-mode choices.
- Review/fixer, CI repair, merge shepherd, dashboard/API, registry, model
  routing, non-Linear tracker adapters, raw GraphQL, and planning/decomposition
  helpers must not be imported into core lifecycle control paths except through
  explicit boundary adapters.
- Validation budget, handoff validation evidence, context-budget safety stops,
  and current-repository GitHub PR URL validation are core contracts that later
  checks may enforce directly.
- Future refactors should move code along these boundaries only after the
  responsibility map is current.
