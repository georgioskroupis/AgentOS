# Doc-gardening pass

Goal: scan repository docs for stale workflow, command, architecture, product,
and quality guidance without expanding the issue into unrelated implementation.

Detection checklist:
- Compare `README.md`, `ARCHITECTURE.md`, `WORKFLOW.md`, and `docs/` against
  current CLI commands, scripts, workflow states, and orchestration behavior.
- Flag docs that describe removed commands, old lifecycle states, stale PR
  requirements, or validation gates that no longer exist.
- Confirm new public commands and behavior changes are documented in the
  shortest source-of-truth page.

Acceptance criteria:
- Update only stale or missing documentation.
- File follow-up issues for broad product or architecture decisions.
- Run `npm run agent-check`.
- Handoff lists docs changed, validation, and remaining follow-up recommendations.
