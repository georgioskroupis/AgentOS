# Unpublished issue branch and failed PR creation report

Goal: detect completed local issue work that failed to become a recorded PR or
handoff because the branch was not published or PR creation failed after commit.

Detection checklist:
- Find local issue branches with committed work not pushed to origin.
- Find validation, handoff, or PR body artifacts present without a recorded PR
  in durable issue state or handoff output.
- Flag `agent_pr_creation_failed` after a successful commit, especially when
  validation passed and PR metadata can be reconstructed.
- Compare branch head SHA, origin branch SHA, validation evidence, handoff note,
  PR body, and current Linear state before recommending repair.

Acceptance criteria:
- Produce a report with issue identifier, branch name, local and remote SHAs,
  artifact paths, and exact next safe publication action.
- Do not create or update PRs unless the issue explicitly asks for repair.
- Run `npm run agent-check`.
- Handoff includes the report and targeted follow-up issues.
