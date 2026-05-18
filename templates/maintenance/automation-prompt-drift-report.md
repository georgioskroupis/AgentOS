# Automation prompt drift report

Goal: detect stale or contradictory automation prompts, context packs, and
workflow instructions before they dispatch low-quality agent turns.

Detection checklist:
- Compare `WORKFLOW.md`, generated context pack content, reusable skills, and
  orchestrator prompt rendering for contradictory instructions.
- Confirm implementation prompts require existing-implementation audit,
  validation evidence, handoff writing, no nested orchestrator launches, and
  deterministic PR creation after local branches are published.
- Ensure health-check prompts apply to any AgentOS workflow state and project,
  not to a hard-coded roadmap identifier range.

Acceptance criteria:
- Update stale prompt/template text narrowly or report follow-up issues.
- Preserve clear source-of-truth ownership between workflow policy, skills, and
  generated prompts.
- Run `npm run agent-check`.
- Handoff lists prompt surfaces reviewed and drift found.
