# Test Suite Map

This map keeps the AgentOS test suite understandable before validation-speed
work. A test may be slow or broad only when it protects a source-of-truth
contract that would be weaker as a narrow unit test.

## Layer Rules

| Layer | Use For | Add A Test When |
| --- | --- | --- |
| Unit | Pure parsing, scoring, classification, redaction, policy, and evidence rules | A behavior can be proven without fake Linear, GitHub, workspaces, or Codex runner state |
| Boundary | CLI helpers, GitHub/Linear wrappers, shell scripts, and file-system contracts | The important behavior is command shape, redaction, idempotency, or provider adapter semantics |
| Integration | Orchestrator, registry, lifecycle, recovery, and runner flows across fake adapters | The contract depends on state transitions, durable artifacts, workspace isolation, or multiple boundaries together |
| Certification | Release or roadmap closeout evidence maps | The test prevents a certification artifact from drifting away from the underlying tests |
| Full harness | `npm run agent-check` and GitHub CI | The repository needs the complete gate, not local proof for a single changed behavior |

Prefer the narrowest layer that protects the behavior. Do not add integration
coverage just because a helper is reachable through the orchestrator. Do not
remove integration coverage when the behavior is specifically about the
orchestrator combining several boundaries.

## Audit Findings

- No tests were removed in VER-111. The audit did not find a clearly obsolete
  or duplicate test that could be deleted without weakening a current
  source-of-truth contract.
- Certification tests intentionally duplicate scenario names from release
  artifacts. They are drift guards, not replacement coverage.
- `tests/orchestrator.test.ts` remains intentionally broad because it is the
  only place many Linear state, workspace, review, CI, merge, and recovery
  behaviors are proven together. It is the main candidate for VER-110 timeout
  and budget work, and future refactors should split coherent domains out only
  when the split preserves cross-boundary assertions.
- `tests/status.test.ts` is broad because operator-facing status text combines
  run state, recovery state, CI state, daemon freshness, and next-action
  guidance. Narrow helpers may be extracted later, but snapshot-like status
  assertions should keep proving end-user legibility.
- `tests/scope-report.test.ts`, `tests/review-retry.test.ts`, `tests/runs.test.ts`,
  `tests/github.test.ts`, and `tests/runner.test.ts` cover high-risk rules where
  regressions previously caused dogfood failures. Keep them behavior-focused.
- Fixture-only tests should remain rare. Current fixture-heavy coverage exists
  to prove fake adapter contracts, generated harness files, or release
  certification maps rather than fixture contents alone.

## Validation Budget Classes

- Focused checks: run the smallest relevant `npm test -- <file>`, script check,
  or smoke proof while editing a narrow behavior.
- Full local harness: run `npm run agent-check` before handoff when local
  dependencies are available and the change affects source, workflow, tests, or
  public docs.
- Reused unchanged-head evidence: reuse previous full validation only when the
  selected head, workflow/config hash, trust mode, automation profile, repair
  policy, and validation risk profile still match.
- GitHub CI authority: when local full validation is unavailable or a local run
  is inconclusive, record the focused local checks and require green GitHub CI
  before merge.

`scripts/agent-check.sh` reports phase start, periodic still-running heartbeat
lines, and final per-phase duration. Set `AGENT_CHECK_HEARTBEAT_SECONDS` to tune
the heartbeat interval for local runs. This makes slow-but-healthy validation
visible without lowering coverage expectations.

During VER-110 validation, local `npm run agent-check` with
`AGENT_CHECK_HEARTBEAT_SECONDS=60` showed:

- harness contract, format, lint, and typecheck completed quickly with accurate
  phase durations;
- unit/integration tests emitted heartbeat lines and passed after about 637s;
- coverage began a second full Vitest pass and continued emitting heartbeat
  lines beyond 600s before the supervisor stopped the local run to avoid tying
  up the shared shell session.

That run demonstrates the issue is no longer silent/stall-like locally. It also
confirms the remaining cost problem is the deliberate full test plus full
coverage double pass, which should be handled by future validation-budget work
only with a replacement proof strategy.

## Slow-Path Timing Notes

VER-110 focused validation confirmed that the slow-but-legitimate local paths
are concentrated in integration scenarios that exercise fake Linear, GitHub,
workspace, review, CI, and status behavior together:

```bash
npm test -- tests/status.test.ts tests/orchestrator.test.ts -t "dispatches eligible issues|records already-satisfied|records investigation-only|runs automated reviewers|runs a bounded CI fixer|keeps using bounded CI fixer|records clean recovered branch|status" --reporter verbose
```

That representative slice passed in about 26 seconds. Individual slow tests
included automated review, mechanical CI fixer, changed-CI-fingerprint retry,
and terminal workspace/status drift scenarios. These are legitimate
integration-budget tests, not obsolete coverage. Future timeout work should
prefer extracting narrow helpers or shared fake setup only where it preserves
the cross-boundary assertion.

## Inventory

| File | Layer | Contract Protected |
| --- | --- | --- |
| `tests/agent-lifecycle-cli.test.ts` | Boundary | Repo-local lifecycle wrappers, trusted supervisor decisions, path safety, and tracker-tool gating |
| `tests/agent-lifecycle.test.ts` | Boundary | Agent-owned and hybrid Linear lifecycle comments, markers, PR metadata, and handoff writes |
| `tests/app-proof-scripts.test.ts` | Boundary | Application proof scripts record configured proof without leaking secret-bearing command strings |
| `tests/capacity-wait.test.ts` | Unit | Codex usage-limit/capacity wait parsing stays distinct from ordinary failures |
| `tests/characterization.test.ts` | Certification | Legacy and roadmap characterization behavior remains visible while later tests harden it |
| `tests/check-scripts.test.ts` | Boundary | Architecture/docs check scripts emit remediation-friendly failures |
| `tests/context-pack.test.ts` | Unit | Targeted prompt context stays bounded, sanitized, and role-specific |
| `tests/daemon-identity.test.ts` | Unit | Daemon identity metadata is deterministic, repo-scoped, and stale-safe |
| `tests/daemon-lifecycle.test.ts` | Boundary | Daemon start/stop/restart/status commands prevent parallel daemons and attach safely |
| `tests/daemon-log.test.ts` | Boundary | Daemon crash and stop markers are timestamped and append-only |
| `tests/env.test.ts` | Unit | Repo-local environment loading reports missing, malformed, placeholder, and override cases |
| `tests/github-context.test.ts` | Unit | GitHub check diagnostics survive into review context in bounded form |
| `tests/github.test.ts` | Boundary | GitHub CLI boundary, PR status, CI diagnostics, branch updates, readiness, merge, and cleanup semantics |
| `tests/harness.test.ts` | Boundary | Harness generation includes required portable project files |
| `tests/high-throughput-certification.test.ts` | Certification | VER-54 certification evidence points to real tests |
| `tests/issue-state.test.ts` | Unit | Handoff parsing, human decisions, PR roles, legacy migration, and app proof metadata |
| `tests/landing-policy.test.ts` | Unit | High-throughput landing gates remain explicit and public defaults remain conservative |
| `tests/landing-preflight.test.ts` | Unit | Landing preflight combines validation, CI, daemon freshness, branch freshness, and report-only blockers |
| `tests/linear-planned-issues.test.ts` | Boundary | Planning-to-DAG issue creation, idempotency markers, blockers, and credential failure behavior |
| `tests/linear.test.ts` | Boundary | Linear pagination, comments, markers, state moves, relations, and setup-state creation |
| `tests/maintenance.test.ts` | Boundary | Maintenance templates and seeding helper stay available and structurally valid |
| `tests/mvp-certification.test.ts` | Certification | MVP certification evidence and source-alignment score remain current |
| `tests/orchestrator-startup-preflight.test.ts` | Integration | Startup singleton preflight refuses competing daemons without blocking safe ownership cases |
| `tests/orchestrator.test.ts` | Integration | End-to-end orchestration across issue states, workspaces, runner turns, review, CI, recovery, merge, and guardrails |
| `tests/phase-timing.test.ts` | Unit | Phase timing redacts validation commands and preserves artifact hashes |
| `tests/pr-script.test.ts` | Boundary | Non-interactive PR creation script creates or reuses PRs through explicit `gh` arguments |
| `tests/project-profiler.test.ts` | Unit | Project profiling detects stack/profile and handles Codex summary fallbacks safely |
| `tests/recovery.test.ts` | Integration | Operator recovery accepts only clean, current, validated work and records proof |
| `tests/redaction.test.ts` | Unit | Secrets and sensitive runner/tracker output are redacted before persistence or comments |
| `tests/registry-orchestrator.test.ts` | Integration | Registry scheduling, project locks, fairness, capacity, and transient project errors |
| `tests/review-budget.test.ts` | Unit | Review-budget split recommendations distinguish broad work from narrow mechanical findings |
| `tests/review-retry.test.ts` | Integration | Reviewer artifact retry, parallel reviewer behavior, optional reviewers, and capacity waits |
| `tests/review.test.ts` | Unit | Review artifact normalization, repeated findings, stale artifact detection, and malformed artifacts |
| `tests/runner.test.ts` | Boundary | Codex App Server protocol, sandbox roots, event policies, stalls, nested orchestrator prevention, and stdout bounds |
| `tests/runs.test.ts` | Boundary | Run summaries, events, hashes, cycle-time diagnostics, replay/simulation, and large payload handling |
| `tests/runtime-state.test.ts` | Unit | Runtime-state schema defaults and migration-safe parsing |
| `tests/scope-report.test.ts` | Unit | Pre-dispatch scope scoring, decomposition evidence, existing implementation audits, and planning guardrails |
| `tests/setup-wizard.test.ts` | Boundary | Setup wizard dry runs, workflow preservation, review defaults, and local harness installation |
| `tests/status.test.ts` | Integration | Operator status output, inspect text, daemon freshness, waits, recovery, CI, and next safe actions |
| `tests/trust.test.ts` | Unit | Trust-mode sandbox/network/tool policy parsing and validation |
| `tests/validation.test.ts` | Unit | Validation evidence freshness, final-result semantics, reuse profiles, and duplicate full validation detection |
| `tests/workflow.test.ts` | Unit | Workflow parsing, strict config validation, automation axes, review/merge targets, and public defaults |
| `tests/workspace.test.ts` | Boundary | Workspace key sanitization, hooks, locks, stale recovery, and dirty-source bootstrap refusal |

## When To Prune

Prune or merge a test only when one of these is true:

- A narrower test already proves the same public contract and the broader test
  adds no cross-boundary assertion.
- The test preserves an obsolete state, command, or lifecycle rule that no
  current docs, workflow config, or source-alignment artifact still supports.
- The test asserts implementation structure without protecting user-visible,
  operator-visible, or machine-contract behavior.
- The test only verifies fixture text that is already enforced by a stronger
  docs, architecture, or harness-contract check.

When broad coverage remains necessary, include that reason in this file so
VER-110 can tune timeouts and validation budgets without weakening the harness.
