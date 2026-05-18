# Quality-score refresh

Goal: refresh `docs/quality/QUALITY_SCORE.md` so the rubric tracks the current
AgentOS harness and orchestration health model.

Detection checklist:
- Verify the rubric covers context, validation, observability, lifecycle, review
  loops, restart recovery, app legibility, source alignment, merge cleanup
  health, daemon/runtime freshness, monitor automation health, and PR
  publication/handoff completion health.
- Compare the rubric with current scripts, workflow policy, status output,
  inspect output, validation evidence, and harness templates.
- Turn concrete missing capabilities into follow-up issues instead of hiding
  gaps inside aspirational scoring text.

Acceptance criteria:
- Update the quality rubric or record that it is already current.
- Keep the rubric portable to target repositories installed by `agent-os init`.
- Run `npm run agent-check`.
- Handoff lists quality areas reviewed and any follow-up work.
