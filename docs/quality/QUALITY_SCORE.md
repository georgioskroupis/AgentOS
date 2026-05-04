# Quality Score

Use this as a lightweight rubric for harnessed repositories.

| Area | Target |
| --- | --- |
| Context | `AGENTS.md`, architecture, workflow, and product docs exist |
| Validation | One local command verifies the common quality gates |
| Workflow | Ticket lifecycle and handoff expectations are documented |
| Skills | Planning, implementation, bug fixing, review, CI diagnostics, QA smoke, docs, tests, and cleanup workflows are reusable and versioned |
| Safety | Public behavior, dependencies, and security changes require justification |
| Orchestration | Linear polling, lifecycle comments, retries, workspace isolation, audit/no-op handoff, Wiggum review, and merge shepherding are executable |

## Minimum Passing Harness

- `AGENTS.md`
- `ARCHITECTURE.md`
- `WORKFLOW.md`
- `docs/product/README.md`
- `docs/quality/QUALITY_SCORE.md`
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
  move the issue to review after handoff.
- Handoffs that reference `Validation-JSON` are not moved to review unless the
  evidence verifies successfully; missing handoffs and dead/stalled Codex App
  Server turns fail through the retry/failure path.
- Stall detection is event-based: active Codex output refreshes the running
  attempt, while truly silent attempts are still aborted and retried.
- Agent turns do not recursively launch nested AgentOS orchestrators; follow-up
  or probe issues stay visible in Linear and are dispatched by the top-level
  scheduler.
- Already-satisfied issues can produce an `AgentOS-Outcome: already-satisfied`
  no-op handoff that is persisted and moved to review without a PR.
- Handoffs can represent zero, one, or many PR outputs; optional `prs[]` is the
  authoritative PR list and legacy `prUrl` is only the first-PR compatibility
  mirror.
- PR-producing implemented issues run automated review before `Human Review`;
  blocking findings create focused fixer turns, review artifacts are persisted,
  and repeated or unresolved findings escalate with `reviewStatus:
  human_required`.
- GitHub CI exists and the merge shepherd requires at least one successful check
  before moving `Merging` issues to `Done`.
- `scripts/check-harness-contract.mjs` is part of `npm run agent-check` and
  enforces canonical states, the handoff contract, Wiggum config, and approved
  production dependencies.
