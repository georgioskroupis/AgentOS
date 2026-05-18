# Obsolete skill cleanup

Goal: keep reusable agent skills accurate, non-duplicative, and aligned with
current AgentOS workflow expectations.

Detection checklist:
- Compare `skills/` and `templates/base-harness/.agents/skills/` for obsolete
  steps, duplicate workflow concepts, or stale command references.
- Confirm skills still require audit before editing, targeted validation,
  validation evidence, and deterministic PR creation when a PR is needed.
- Flag skills that describe tracker writes or lifecycle ownership inconsistent
  with the current workflow policy.

Acceptance criteria:
- Remove or update only stale skill guidance.
- Preserve concise, reusable workflows instead of embedding issue-specific
  history.
- Run `npm run agent-check`.
- Handoff lists skills reviewed and any follow-up issues.
