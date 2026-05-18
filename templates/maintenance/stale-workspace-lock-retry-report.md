# Stale workspace, lock, and retry report

Goal: find stale AgentOS workspaces, runner locks, active issue drift, and retry
state that could cause duplicate or stalled work.

Detection checklist:
- Detect more than one active issue when the workflow concurrency policy expects
  one.
- Detect active issues stale in `In Progress`, `Human Review`, or `Merging`.
- Find stale workspace locks, stale worktrees, dirty workspaces, and retry queue
  entries that no longer match current Linear or durable state.
- Ignore expected runtime artifacts while still reporting local dirty source
  state outside ignored files.

Acceptance criteria:
- Produce a report with issue identifiers, workspace paths, lock owners, retry
  metadata, and the smallest next safe action.
- Create follow-up issues for cleanup or recovery when operator action is safer
  than automated repair.
- Run `npm run agent-check`.
- Handoff includes the report and any linked follow-up issues.
