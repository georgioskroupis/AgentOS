# Stale daemon and repo-SHA report

Goal: detect stale root repository state or long-running AgentOS daemon code
after `main` advances.

Detection checklist:
- Check whether root `main` is behind `origin/main`.
- Check whether the daemon is stopped, has a stale PID, failed to launch, lacks
  required repo-local environment, or is running code from before `main`
  advanced.
- Compare daemon health, runtime freshness state, local `HEAD`, `main`, and
  `origin/main` before recommending restart.

Acceptance criteria:
- Produce a report with repo SHAs, daemon status, freshness status, and next
  safe restart or fast-forward action.
- Do not restart or kill processes unless the issue explicitly asks for repair.
- Run `npm run agent-check`.
- Handoff includes the report and follow-up repair issues if needed.
