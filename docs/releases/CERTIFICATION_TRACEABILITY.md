# Certification Traceability

This matrix ties high-confidence certification claims to current code paths,
tests, and proof commands. Linear status alone is not certification evidence.

| Linear issue | Acceptance focus | Code path | Test or artifact | Proof command | Status |
| --- | --- | --- | --- | --- | --- |
| VER-15 | Deterministic per-issue workspaces and bootstrap hooks | `src/workspace.ts` | `tests/workspace.test.ts` | `npm test -- tests/workspace.test.ts --reporter verbose` | Corrected by VER-126 / PR #100 |
| VER-55 | MVP scenario certification and source-alignment closeout | `docs/releases/MVP.md`, `docs/planning/SOURCE_ALIGNMENT_AUDIT.md` | `tests/mvp-certification.test.ts` | `npm test -- tests/mvp-certification.test.ts --reporter verbose` | Covered, with post-review correction recorded |
| VER-69 | Parallel reviewer scheduling and artifact retry behavior | `src/reviewer-runner.ts`, `src/orchestrator.ts` | `tests/review-retry.test.ts`, `tests/orchestrator.test.ts` | `npm test -- tests/review-retry.test.ts --reporter verbose` | Covered by focused and integration tests |
| VER-106 | Dashboard/API as optional observability surface | `src/http-server.ts`, `dashboard/` | `tests/http-server.test.ts`, `scripts/check-dashboard.mjs` | `npm test -- tests/http-server.test.ts --reporter verbose && npm run check:dashboard` | Covered as optional extension |
| VER-111 | Test-suite audit and validation gate clarity | `docs/quality/TEST_SUITE.md`, `scripts/agent-check.sh` | `tests/check-scripts.test.ts` | `npm test -- tests/check-scripts.test.ts --reporter verbose && npm run agent-check` | Covered; validation-cost work remains separate |
| VER-113 | Hook/bootstrap failure becomes structured recovery, not daemon crash | `src/orchestrator-workspace-bootstrap.ts`, `src/workspace.ts` | `tests/orchestrator.test.ts`, `tests/workspace.test.ts` | `npm test -- tests/workspace.test.ts tests/orchestrator.test.ts -t "workspace|bootstrap" --reporter verbose` | Covered, strengthened by PR #100 |
| VER-126 | Post-review workspace hook cwd/create/partial-bootstrap correction | `src/workspace.ts`, `scripts/agent-bootstrap-worktree.sh` | `tests/workspace.test.ts`, `tests/workflow.test.ts` | `npm test -- tests/workspace.test.ts tests/workflow.test.ts --reporter verbose` | Complete |
| VER-128 | Lifecycle event and tracker boundary interfaces for the A+ refactor | `src/lifecycle-events.ts`, `src/tracker-boundaries.ts`, `scripts/check-architecture.mjs` | `tests/check-scripts.test.ts`, `docs/architecture/ORCHESTRATOR_RESPONSIBILITIES.md` | `npm test -- tests/check-scripts.test.ts --reporter verbose && npm run check:architecture` | Complete in PR #102 |
| VER-129 | Existing orchestrator lifecycle writes routed through the lifecycle event/controller boundary without default or extension behavior changes | `src/orchestrator.ts`, `src/lifecycle-controller.ts`, `src/lifecycle-events.ts`, `scripts/check-architecture.mjs` | `tests/orchestrator.test.ts`, `tests/check-scripts.test.ts`, `docs/architecture/ORCHESTRATOR_RESPONSIBILITIES.md` | `npm test -- tests/orchestrator.test.ts tests/check-scripts.test.ts --reporter verbose && npm run check:architecture` | Active in lifecycle-extraction PR |

## Certification Rules

- A certification row must name at least one code path and one executable proof.
- Optional extensions must be labeled as optional or high-trust; they must not be
  treated as core Symphony proof.
- If a post-review correction changes the meaning of an old Done issue, add a
  new row instead of rewriting historical Linear state.
- Live E2E proof is gated by `npm run certification:e2e`; it is required for
  release certification only when credentials and an isolated certification
  workflow are available.
