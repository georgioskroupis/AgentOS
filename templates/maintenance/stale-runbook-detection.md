# Stale runbook detection

Goal: find operational runbooks whose steps no longer match current AgentOS
commands, scripts, lifecycle ownership, or failure behavior.

Detection checklist:
- Review `docs/runbooks/` for commands that no longer exist or require
  different arguments.
- Compare runbook recovery steps with current `status`, `inspect`, `daemon`,
  `recovery`, lifecycle wrapper, and PR creation behavior.
- Check that recurring maintenance, CI repair, merge shepherding, and daemon
  restart guidance point to deterministic commands rather than interactive
  Linear or GitHub workflows.

Acceptance criteria:
- Patch stale runbook steps narrowly.
- Preserve source-of-truth policy in `WORKFLOW.md`; runbooks should reference it
  rather than restating long policy blocks.
- Run `npm run agent-check`.
- Handoff includes stale runbooks found and any follow-up issues.
