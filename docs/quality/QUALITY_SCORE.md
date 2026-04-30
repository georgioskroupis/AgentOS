# Quality Score

Use this as a lightweight rubric for harnessed repositories.

| Area | Target |
| --- | --- |
| Context | `AGENTS.md`, architecture, workflow, and product docs exist |
| Validation | One local command verifies the common quality gates |
| Workflow | Ticket lifecycle and handoff expectations are documented |
| Skills | Common workflows are reusable and versioned |
| Safety | Public behavior, dependencies, and security changes require justification |
| Orchestration | Linear polling, lifecycle comments, retries, workspace isolation, audit/no-op handoff, and merge shepherding are executable |

## Minimum Passing Harness

- `AGENTS.md`
- `ARCHITECTURE.md`
- `WORKFLOW.md`
- `docs/product/README.md`
- `docs/quality/QUALITY_SCORE.md`
- `scripts/agent-check.sh`
- `.agents/skills/fix-bug/SKILL.md`
- `.agents/skills/implement-feature/SKILL.md`

## Minimum Passing Symphony Integration

- `WORKFLOW.md` front matter defines Linear project, active states, running
  state, review state, needs-input state, terminal states, workspace root, and
  Codex App Server command.
- `agent-os linear teams` succeeds with the configured Linear credentials.
- `agent-os codex-doctor` reports App Server support.
- `agent-os orchestrator once --repo <repo> --workflow WORKFLOW.md` can dispatch
  an eligible issue into a deterministic workspace, post Linear progress, and
  move the issue to review after handoff.
- Already-satisfied issues can produce an `AgentOS-Outcome: already-satisfied`
  no-op handoff that is persisted and moved to review without a PR.
- GitHub CI exists and the merge shepherd requires at least one successful check
  before moving `Merging` issues to `Done`.
