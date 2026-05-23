# Quality Score

Use this as a lightweight rubric for harnessed repositories.

| Area | Target |
| --- | --- |
| Context | `AGENTS.md`, architecture, workflow, product docs, and targeted context packs give agents the smallest current source of truth |
| Validation | One local command verifies common gates, validation evidence records command attempts, unchanged-head reuse is explicit, and test-suite layers are documented |
| Observability | `status`, `inspect`, run artifacts, sanitized logs, validation timing, CI state, and app proof point operators to the next safe action |
| Model routing | Per-role model policy is report-only until proven safe; telemetry records role, model, reasoning effort, elapsed time, tokens, cost bucket, and promotion/refusal reasons |
| Lifecycle | Workflow states, lifecycle ownership, Linear comments, handoff outcomes, and tracker-write boundaries are documented and enforced |
| Review loops | Required reviewers, reviewer artifacts, fixer iterations, review budgets, and human escalation paths are explicit |
| Restart recovery | Dead/stalled runs, durable retries, startup reconstruction, stale locks, and capacity waits recover without duplicate work |
| Application legibility | Start, health, smoke, logs, metrics, traces, CI logs, and UI/browser proof are documented when applicable |
| Source alignment | Harness, skills, prompts, workflow policy, and docs stay aligned with current implementation and source-faithful boundaries |
| Merge cleanup health | Merged PRs, Linear state, durable issue state, local/remote branches, and workspace cleanup drift are operator-visible |
| Daemon/runtime freshness | Daemon liveness, credential preflight, repo-local env, stale PID files, root `main`, `origin/main`, and daemon start SHA are checked |
| Monitor automation health | Recurring maintenance templates detect stale docs, runbooks, architecture, skills, prompts, workspaces, locks, retries, PRs, and daemon state |
| PR publication/handoff completion health | Local committed issue branches, pushed origin heads, validation/handoff/PR body artifacts, recorded PR metadata, and `agent_pr_creation_failed` outcomes are reconciled |

## Minimum Passing Harness

- `AGENTS.md`
- `ARCHITECTURE.md`
- `WORKFLOW.md`
- `docs/product/README.md`
- `docs/quality/APP_LEGIBILITY.md`
- `docs/quality/PROOF_OF_WORK.md`
- `docs/quality/QUALITY_SCORE.md`
- `docs/quality/TEST_SUITE.md`
- `scripts/agent-check.sh`
- `.agents/skills/fix-bug/SKILL.md`
- `.agents/skills/implement-feature/SKILL.md`
- `.agents/skills/review-pr/SKILL.md`
- `.agents/skills/ci-diagnostics/SKILL.md`
- `.agents/skills/qa-smoke-test/SKILL.md`

## Minimum Passing Symphony Integration

- `WORKFLOW.md` front matter defines Linear project, active states, running
  state, review state, needs-input state, terminal states, workspace root, and
  Codex App Server command.
- `agent-os setup <project-path>` can initialize a single project with a
  tailored harness and Linear project/workflow setup.
- `agent-os linear teams` succeeds with the configured Linear credentials.
- `agent-os codex-doctor` reports App Server support.
- `agent-os orchestrator once --repo <repo> --workflow WORKFLOW.md` can dispatch
  an eligible issue into a deterministic workspace, post Linear progress, and
  move the issue to review after handoff. Before dispatch, it emits a
  scope report for active candidates, including Linear comment, trusted
  human-decision, and repo-root/workspace/run handoff evidence, and applies
  guardrails that stop duplicate/recoverable partial work and pause likely-large
  missing work for planning/decomposition without creating child issues directly.
  Scope reports also recognize Linear parent/child decomposition evidence so
  decomposed parents route to child completion or parent closeout instead of
  repeated implementation dispatch.
- `scripts/agent-linear-comment.sh`, `scripts/agent-linear-move.sh`,
  `scripts/agent-linear-pr.sh`, and `scripts/agent-linear-handoff.sh` provide
  deterministic agent-owned tracker writes for configured `hybrid` or
  strict-gated `agent-owned` projects, with JSON results and run/attempt
  marker correlation.
- `scripts/agent-linear-plan-issues.sh` turns approved decomposition plans into
  marker-backed child/follow-up issues with parent, assignee continuity, and
  requested dependency links.
- Handoffs that reference `Validation-JSON` are not moved to review unless the
  evidence verifies successfully; missing handoffs and dead/stalled Codex App
  Server turns fail through the retry/failure path. Durable runtime state lets
  startup rebuild retries, classify stale running summaries, release stale
  workspace locks, and clear retry metadata for terminal or already-merged
  issues before dispatch.
- Stall detection is event-based: active Codex output refreshes the running
  attempt, while truly silent attempts are still aborted and retried.
- Agent turns do not recursively launch nested AgentOS orchestrators; follow-up
  or probe issues stay visible in Linear and are dispatched by the top-level
  scheduler.
- Already-satisfied issues can produce an `AgentOS-Outcome: already-satisfied`
  no-op handoff that is persisted and moved to review without a PR.
- Handoffs can represent zero, one, or many PR outputs; optional `prs[]` is the
  authoritative PR list and legacy `prUrl` is only the first-PR compatibility
  mirror. PR roles make review and merge targets explicit.
- PR-producing implemented issues run automated review before `Human Review`;
  blocking findings create focused fixer turns, review artifacts are persisted,
  missing/malformed/stale/incomplete reviewer artifacts are retried narrowly per
  reviewer, review budget signals recommend split/follow-up work for broad or
  non-mechanical exhaustion, and repeated or unresolved findings or exhausted
  runner failures escalate with `reviewStatus: human_required`.
- Implementation re-entry, automated review, fixer, and mechanical CI repair
  turns receive targeted context packs with bounded issue text, selected PR
  metadata, diff excerpts, current findings, validation summaries, sanitized
  logs, and artifact references instead of historic transcripts. Context-budget
  diagnostics estimate prompt size, list included large sections with reasons,
  and enforce configured per-turn/cumulative limits.
- Validation evidence distinguishes focused checks, full local harness proof,
  matching unchanged-head reuse, and CI proof. Duplicate full-suite runs for the
  same head are budgeted so small follow-up fixes do not repeat expensive
  `npm run agent-check` work without new information. Reuse is valid only when
  the selected head, validation head, workflow/config hash, trust mode,
  automation profile, repair policy, and validation risk profile still match.
- Model routing starts as observability. Low-risk read-only roles may propose a
  cheaper/faster model in `report-only` mode, while implementation, fixer, CI
  repair, security, architecture, lifecycle, recovery, merge, and other
  write-capable or sensitive scopes retain the inherited high-capability model
  unless trusted workflow config explicitly applies a route. Malformed
  artifacts, ambiguous findings, and repeated iterations promote or refuse the
  downgrade and are visible in run/review artifacts.
- GitHub CI exists and the merge shepherd requires at least one successful check
  before merging the selected primary target and moving `Merging` issues to
  `Done`; post-merge cleanup failures are operator-visible warnings, not
  implementation retries. High-throughput landing certification is recorded in
  `docs/releases/high-throughput-landing-certification.json`, mapping VER-54
  child work to concrete tests for landing gates, CI diagnostics, trusted
  decisions, draft PR readiness, selected-target merge, cleanup, conservative
  defaults, and report-only protected-branch/merge-queue handling.
- `agent-os orchestrator once-registry`, `agent-os orchestrator run-registry`,
  and `agent-os status --registry` coordinate multiple registered projects with
  global and per-project capacity, fair dispatch, project runner locks,
  project-level workflow config, transient tracker/network error summaries,
  CI/review/merge/retry wait visibility, daemon freshness, and local validation
  timing evidence.
- `scripts/check-harness-contract.mjs` is part of `npm run agent-check` and
  enforces canonical states, the handoff contract, Wiggum config, and approved
  production dependencies.
