# Decision 0002: Optional Extension Boundaries

## Context

AgentOS implements the Harness Engineering and Symphony core, then layers local
operator conveniences on top. Symphony treats a rich web UI/control plane and
general workflow engine behavior as non-goals for the core scheduler, so
extension surfaces need to stay visible and opt-in.

## Decision

Classify the main surfaces as follows:

| Surface | Classification |
| --- | --- |
| Workflow loader and strict validator | Core |
| Workspace manager and workspace hooks | Core |
| Tracker reader and issue eligibility | Core |
| Codex runner boundary | Core |
| Orchestrator dispatch, retry, and recovery | Core |
| Status and inspect CLI | Core |
| Dashboard/API | Optional extension |
| Registry-wide orchestration | Optional extension |
| High-throughput landing | High-trust extension |
| Model routing | Optimization extension |
| Tracker adapters beyond Linear | Extension |
| `linear_graphql` client tool | Experimental extension |
| Merge shepherd | High-trust extension |

Core surfaces must remain conservative and source-faithful by default.
Extensions may ship in this repository, but their docs, config gates, and tests
must preserve the boundary.

## Consequences

- Public templates keep conservative defaults.
- Dashboard/API and registry behavior must not become required for ordinary
  single-project orchestration.
- High-throughput merge behavior stays behind explicit trust, automation, and
  merge-mode choices.
- Future refactors should move code along these boundaries only after the
  responsibility map is current.
