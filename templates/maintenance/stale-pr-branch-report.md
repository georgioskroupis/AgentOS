# Stale PR and branch report

Goal: report stale pull request, branch, and check state that can block review
or merge without changing product code.

Detection checklist:
- Find open PRs whose checks are failing, missing, pending too long, or recorded
  against a different head SHA than the local issue state.
- Find draft PRs or stale PR heads when local committed work has advanced.
- Compare local issue branches, remote branches, durable PR metadata, and handoff
  PR links for mismatches.

Acceptance criteria:
- Produce a concise report with PR URLs, branch names, head SHAs, check state,
  and next safe actions.
- Seed targeted follow-up issues for mechanical cleanup rather than repairing
  unrelated PRs inside this issue.
- Run `npm run agent-check`.
- Handoff includes the report location or inline findings.
