# AgentOS MVP Certification

Certification issue: VER-55

Status: certified.

This checkpoint certifies the AgentOS MVP against the source-faithful roadmap
derived from OpenAI Harness Engineering and Symphony. The MVP bar is not "all
future automation is complete"; it is that AgentOS now has a coherent
issue-first control plane, repo-local harness, bounded review and repair loops,
durable recovery, registry scheduling, application proof hooks, recurring
maintenance, and explicit remaining deviations.

Post-review correction: a later source-faithfulness review confirmed one real
gap in workspace lifecycle hooks: bootstrap hooks did not consistently run from
an already-created per-issue workspace, and partial bootstrap state could be
misread as reusable. That gap is tracked as a post-MVP hardening correction.
The same review also surfaced stale claims that are now reconciled in current
repo state: package-level lint, format, and coverage gates are present; Codex is
pinned in `WORKFLOW.md`; human merge override is disabled; and strict workflow
validation passes.

## Source Anchors

- Harness Engineering: repository-local tools and docs, mechanical guardrails,
  application legibility, review/fix loops, cheap correction, and recurring
  cleanup.
- Symphony: issue tracker as control plane, issues as work units, deterministic
  per-issue workspaces, bounded orchestration, durable retry/reconciliation,
  explicit trust posture, observability, and scheduler/runner/tracker-reader
  boundaries.

## Scenario Evidence

| Scenario | Status | Evidence |
| --- | --- | --- |
| Already-satisfied no-PR issue | Covered | `tests/orchestrator.test.ts` - `records already-satisfied no-op handoffs without requiring a PR`; `docs/releases/v0.1.0-rc1.md` records real VER-31 no-PR dogfood |
| Investigation-only issue | Covered | `tests/orchestrator.test.ts` - `records investigation-only implemented handoffs without requiring a PR` |
| Planning-to-DAG issue | Covered | `tests/linear-planned-issues.test.ts` - `creates child and follow-up issues from plan input with inherited assignees and guardrail-friendly descriptions`; `tests/orchestrator.test.ts` - `skips Todo issues blocked by nonterminal dependencies`; `tests/orchestrator.test.ts` - `dispatches a child issue after its dependency reaches a terminal state` |
| One-PR docs/code issue | Covered | `tests/orchestrator.test.ts` - `runs automated reviewers before moving an implemented PR to Human Review`; VER-99/PR #92 completed as a recent one-PR docs/code issue |
| Multi-PR issue | Covered | `tests/orchestrator.test.ts` - `persists multiple PR outputs without collapsing issue state to one PR`; `docs/releases/high-throughput-landing-certification.json` records selected-target merge behavior |
| Mechanical review failure | Covered | `tests/orchestrator.test.ts` - `runs a focused fixer turn and recomputes review targets from the updated handoff` |
| Mechanical CI failure | Covered | `tests/orchestrator.test.ts` - `runs a bounded CI fixer turn for mechanical failed checks with logs`; `tests/orchestrator.test.ts` - `keeps using bounded CI fixer turns when the same check fails with different logs` |
| User-input/elicitation failure | Covered | `tests/orchestrator.test.ts` - `stops denied MCP elicitation requests for human input without retrying` |
| Crash/restart recovery | Covered | `tests/orchestrator.test.ts` - `rebuilds due retries from durable runtime state after restart` |
| Two-project registry daemon | Covered | `tests/registry-orchestrator.test.ts` - `dispatches fairly across two fake projects under the global cap after restart` |
| Application legibility proof | Covered | `scripts/agent-start-app.sh`, `scripts/agent-smoke-test.sh`, `scripts/agent-capture-logs.sh`, and `scripts/agent-capture-proof.sh`; `tests/app-proof-scripts.test.ts` - `records configured proof commands without persisting secret-bearing command strings` |
| Garbage-collection task | Covered | `tests/maintenance.test.ts` - `seeds every template into the requested Linear project and state`; `tests/maintenance.test.ts` - `exposes the top-level maintenance seed command` |

## Required Validation

Completed on this branch:

```bash
npm test -- tests/mvp-certification.test.ts tests/high-throughput-certification.test.ts --reporter verbose
npm test -- tests/linear-planned-issues.test.ts tests/registry-orchestrator.test.ts tests/app-proof-scripts.test.ts tests/maintenance.test.ts --reporter verbose
npm test -- tests/orchestrator.test.ts -t "records already-satisfied|records investigation-only|skips Todo issues blocked|dispatches a child issue|runs automated reviewers|persists multiple PR|runs a focused fixer|runs a bounded CI fixer|keeps using bounded CI fixer|stops denied MCP|rebuilds due retries" --reporter verbose
AGENT_APP_START_COMMAND="node -e 'console.log(\"agentos proof service ready\"); setTimeout(() => {}, 30000)'" ./scripts/agent-start-app.sh
AGENT_SMOKE_COMMAND="npm test -- tests/app-proof-scripts.test.ts --reporter verbose" ./scripts/agent-smoke-test.sh
./scripts/agent-capture-logs.sh
./scripts/agent-capture-proof.sh
npm run check:docs
npm run check:architecture
npm run typecheck
npm run build
bin/agent-os workflow validate --strict
```

`npm run agent-check` is the full authority for current certification gates. It
runs harness contract, format, lint, typecheck, tests, coverage, build,
architecture, dashboard, docs, security, and contract checks. Historical
validation-runtime noise from long Vitest/coverage phases is tracked separately
from correctness.

The certification also expects a clean tracked source tree before merge. Local
ignored runtime artifacts under `.agent-os/`, `coverage/`, `dist/`, and
`node_modules/` are allowed.

## Intentional Remaining Deviations

1. Public templates remain conservative: human approval, user-input events, and
   merge behavior are explicit trust/lifecycle choices rather than assumed
   high-trust defaults.
2. Linear is the production tracker adapter for MVP. Non-Linear tracker
   adapters remain future work.
3. The optional HTTP dashboard/API is not required for MVP certification because
   CLI status, inspect, registry status, run artifacts, and Linear comments are
   the current operator surfaces.
4. Protected-branch and merge-queue behavior remains report-only unless a
   trusted workflow explicitly opts into supported merge shepherd behavior.
5. `hybrid` and experimental `agent-owned` lifecycle modes exist, but
   orchestrator-owned remains the safe default until broader dogfood evidence
   proves the agent-owned path.

## Non-MVP Future Work

- VER-95: optional Symphony `linear_graphql` client-side tool extension.
- VER-96: optional Symphony HTTP dashboard/API.
- VER-97: pluggable tracker adapters beyond Linear.
- VER-106: dashboard productization over the optional HTTP API.
- VER-107: stronger Human Review drift guard.
- VER-108: review-budget split advisory for mechanical fixer findings.
- VER-110: slow integration-test timeout budgets.
- VER-111: test audit and pruning before validation-speed work.
- VER-112: role-based model routing and cost telemetry.

## Closeout Expectations

- `docs/planning/SOURCE_ALIGNMENT_AUDIT.md` records the final MVP alignment
  score.
- `npm run agent-check` is green.
- `bin/agent-os workflow validate --strict` is green.
- Linear has no active stuck MVP issues.
- No stale workspace locks remain for terminal issues.
- Any runtime warnings are either ignored-state noise or captured as future
  Linear work above.
