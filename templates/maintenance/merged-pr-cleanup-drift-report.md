# Merged-PR cleanup drift report

Goal: detect PRs that merged while AgentOS Linear state, durable state, branch,
workspace, or review metadata cleanup remained incomplete.

Detection checklist:
- Find merged PRs whose Linear issue is still active or whose durable issue
  state still reports pending review, merge, retry, or cleanup work.
- Flag approval/review metadata drift where the safe recovery path is a trusted
  Linear supervisor decision with PR head SHA, validation evidence, CI state,
  findings state, and decision summary.
- Treat GitHub self-approval limits as expected when the PR author cannot
  approve their own PR; require Linear supervisor evidence instead of guessing.
- Check local and remote branch cleanup warnings after successful merges.

Acceptance criteria:
- Produce a report that separates already-merged authoritative evidence from
  best-effort cleanup warnings.
- Recommend the exact Linear decision format when supervisor recovery is needed.
- Run `npm run agent-check`.
- Handoff includes PRs reviewed, cleanup drift found, and follow-up issues.
