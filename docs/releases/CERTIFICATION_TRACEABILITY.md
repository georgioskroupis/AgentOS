# Certification Traceability

This matrix ties high-confidence certification claims to current code paths,
tests, and proof commands. Linear status alone is not certification evidence.

| Linear issue | PR/branch | Classification | Acceptance focus | Code path | Test or artifact | Proof command | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VER-15 | PR #100 | core | Deterministic per-issue workspaces and bootstrap hooks | `src/workspace.ts` | `tests/workspace.test.ts` | `npm test -- tests/workspace.test.ts --reporter verbose` | Corrected by VER-126 / PR #100 |
| VER-55 | PR #93 | core | MVP scenario certification and source-alignment closeout | `docs/releases/MVP.md`, `docs/planning/SOURCE_ALIGNMENT_AUDIT.md` | `tests/mvp-certification.test.ts` | `npm test -- tests/mvp-certification.test.ts --reporter verbose` | Covered, with post-review correction recorded |
| VER-69 | PR #50 | extension | Parallel reviewer scheduling and artifact retry behavior | `src/reviewer-runner.ts`, `src/orchestrator.ts` | `tests/review-retry.test.ts`, `tests/orchestrator.test.ts` | `npm test -- tests/review-retry.test.ts --reporter verbose` | Covered by focused and integration tests; extension proof |
| VER-106 | PR #99 | extension | Dashboard/API historical observability surface | `src/http-server.ts`, `dashboard/` | `tests/http-server.test.ts`, `scripts/check-dashboard.mjs` | `npm test -- tests/http-server.test.ts --reporter verbose && npm run check:dashboard` | Superseded by lean monitor placeholder deletion work |
| VER-111 | PR #94 | core | Test-suite audit and validation gate clarity | `docs/quality/TEST_SUITE.md`, `scripts/agent-check.sh` | `tests/check-scripts.test.ts` | `npm test -- tests/check-scripts.test.ts --reporter verbose && npm run agent-check` | Covered; validation-cost work remains separate |
| VER-113 | PR #79 | core | Hook/bootstrap failure becomes structured recovery, not daemon crash | `src/orchestrator-workspace-bootstrap.ts`, `src/workspace.ts` | `tests/orchestrator.test.ts`, `tests/workspace.test.ts` | `npm test -- tests/workspace.test.ts tests/orchestrator.test.ts -t "workspace" --reporter verbose` | Covered, strengthened by PR #100 |
| VER-126 | PR #100 | core | Post-review workspace hook cwd/create/partial-bootstrap correction | `src/workspace.ts`, `scripts/agent-bootstrap-worktree.sh` | `tests/workspace.test.ts`, `tests/workflow.test.ts` | `npm test -- tests/workspace.test.ts tests/workflow.test.ts --reporter verbose` | Complete |
| VER-128 | PR #102 | core | Lifecycle event and tracker boundary interfaces for the A+ refactor | `src/lifecycle-events.ts`, `src/tracker-boundaries.ts`, `scripts/check-architecture.mjs` | `tests/check-scripts.test.ts`, `docs/architecture/ORCHESTRATOR_RESPONSIBILITIES.md` | `npm test -- tests/check-scripts.test.ts --reporter verbose && npm run check:architecture` | Complete |
| VER-129 | PR #103 | core | Existing orchestrator lifecycle writes routed through the lifecycle event/controller boundary without default or extension behavior changes | `src/orchestrator.ts`, `src/lifecycle-controller.ts`, `src/lifecycle-events.ts`, `scripts/check-architecture.mjs` | `tests/orchestrator.test.ts`, `tests/check-scripts.test.ts`, `docs/architecture/ORCHESTRATOR_RESPONSIBILITIES.md` | `npm test -- tests/orchestrator.test.ts tests/check-scripts.test.ts --reporter verbose && npm run check:architecture` | Complete |
| VER-130 | PR #104 | core | Repo-local Linear lifecycle tools are production-grade before the agent-owned default flip; raw GraphQL stays extension-only | `src/agent-lifecycle.ts`, `src/cli.ts`, `src/lifecycle.ts`, `src/runner/client-tools.ts`, `scripts/agent-linear-*.sh` | `tests/agent-lifecycle.test.ts`, `tests/agent-lifecycle-cli.test.ts`, `tests/workflow.test.ts`, `tests/linear-graphql-tool.test.ts` | `npm test -- tests/agent-lifecycle.test.ts tests/agent-lifecycle-cli.test.ts tests/workflow.test.ts tests/linear-graphql-tool.test.ts --reporter verbose && npm run check:architecture` | Complete |
| VER-131 | PR #105 | core | Agent-owned runs must prove tracker lifecycle evidence before AgentOS considers the run complete | `src/agent-owned-lifecycle-evidence.ts`, `src/orchestrator-agent-owned-evidence.ts`, `src/runs.ts`, `src/types.ts` | `tests/agent-owned-lifecycle-evidence.test.ts` | `npm test -- tests/agent-owned-lifecycle-evidence.test.ts --reporter verbose && npm run check:architecture` | Complete |
| VER-132 | PR #106 | core | Root and base template workflows use `agent-owned` as the default core lifecycle posture while extension behavior remains excluded | `WORKFLOW.md`, `templates/base-harness/WORKFLOW.md`, `src/lifecycle-controller.ts`, `src/lifecycle-events.ts` | `tests/workflow.test.ts`, `tests/lifecycle-controller.test.ts` | `npm test -- tests/workflow.test.ts tests/lifecycle-controller.test.ts tests/agent-owned-lifecycle-evidence.test.ts tests/orchestrator.test.ts --reporter verbose && npm run check:architecture` | Complete |
| VER-133 | PR #107 | legacy | Legacy scheduler-owned lifecycle modes are removed from public workflow config, docs/templates, and certification paths before final A+ certification | `src/lifecycle.ts`, `WORKFLOW.md`, `templates/base-harness/WORKFLOW.md`, `docs/architecture/ORCHESTRATOR_RESPONSIBILITIES.md`, `docs/planning/SOURCE_ALIGNMENT_AUDIT.md` | `tests/workflow.test.ts`, `tests/orchestrator.test.ts`, `tests/agent-lifecycle-cli.test.ts` | `npm test -- tests/workflow.test.ts tests/lifecycle-controller.test.ts tests/agent-lifecycle.test.ts tests/agent-lifecycle-cli.test.ts tests/orchestrator.test.ts --reporter verbose && npm run check:docs && npm run check:architecture` | Complete; any remaining test-only scheduler-owned fallback is a legacy fixture, not public config, excluded from source-faithful core certification, and explicitly final-excluded by VER-134 |
| VER-134 | PR #108 | core | Agent-owned core source-faithful A+ certification with executable local traceability and certification gates | `scripts/check-traceability.mjs`, `scripts/certification-agent-owned.mjs`, `docs/releases/agent-owned-core-certification.json`, `package.json` | `tests/check-scripts.test.ts`, `docs/releases/CERTIFICATION_TRACEABILITY.md` | `npm run check:traceability && npm run certification:agent-owned` | Certified locally in PR #108 |
| VER-134 | live-e2e: credential-gated | live-e2e | Live Linear/GitHub/Codex certification remains isolated from local fake-gated proof | `scripts/certification-e2e.sh` | `tests/check-scripts.test.ts` | `npm run certification:e2e` | Credential-gated; required for release only when isolated live credentials are configured |

## Certification Rules

- A certification row must name at least one code path and one executable proof.
- A certification row must include PR/branch and one classification: `core`,
  `extension`, `legacy`, or `live-e2e`.
- Optional extensions must be labeled as optional or high-trust; they must not be
  treated as core Symphony proof.
- Test-only legacy fixtures must be labeled `legacy`, excluded from core proof,
  and resolved or explicitly final-excluded before A+ certification.
- If a post-review correction changes the meaning of an old Done issue, add a
  new row instead of rewriting historical Linear state.
- `npm run check:traceability` is the machine-readable gate for this matrix and
  `docs/releases/agent-owned-core-certification.json`.
- Live E2E proof is gated by `npm run certification:e2e`; it is required for
  release certification only when credentials and an isolated certification
  workflow are available.
