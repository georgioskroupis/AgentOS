# Maintenance Loop

Use this runbook for recurring AgentOS doc-gardening and health reporting. The
loop should apply to any AgentOS repository and workflow state set; do not scope
the scan to a hard-coded roadmap issue range.

## Seed Recurring Issues

```bash
bin/agent-os maintenance seed --team <team-key-or-id> --project AgentOS
```

The command reads `templates/maintenance/` and creates Backlog issues for the
recurring maintenance categories. `bin/agent-os linear seed-maintenance` remains
as a compatibility alias.

## Supervisor Linear Recovery

Do not use direct GraphQL mutations by Linear UUID for human state repair. Use
the by-identifier supervisor helpers so a pasted UUID cannot move the wrong
issue:

```bash
bin/agent-os supervisor move VER-93 Merging --repo .
bin/agent-os supervisor decide VER-93 proceed-to-merge-after-supervisor-fix \
  --validation .agent-os/validation/VER-93.json \
  --pr-head-sha <sha> \
  --ci-state passed \
  --findings resolved \
  --summary "supervisor repaired the PR head and validation is fresh" \
  --repo .
```

`supervisor move` accepts only human-readable identifiers like `VER-93` and
refuses states outside the configured workflow state set. `supervisor decide`
posts the exact six-field `AgentOS-Human-Decision` format from `WORKFLOW.md`
and verifies that the referenced validation evidence belongs to the issue,
matches the PR head SHA, and includes validation reuse-profile metadata.

Repo-local lifecycle wrappers also accept `--supervisor` for an explicit human
operator bypass, for example:

```bash
scripts/agent-linear-move.sh --supervisor VER-93 Merging
```

Agents must not use the supervisor bypass. Agent calls without `--supervisor`
remain governed by the agent-owned lifecycle policy and must complete through
validation evidence plus handoff artifacts.

## Generic Health-Check Prompt

Use this prompt shape when creating or reviewing a maintenance report:

```text
Audit the current AgentOS repository, workflow, durable issue state, local git
state, daemon health, workspaces, locks, PR metadata, validation artifacts, and
handoff artifacts. Compare the findings with the current `WORKFLOW.md`
configuration instead of assuming a fixed roadmap range.

Report only detection and seeding findings unless the issue explicitly asks for
repair. Include issue identifiers, branch names, PR URLs, head SHAs, artifact
paths, state names, validation status, and the smallest next safe action.
```

## Detection Checklist

- More than one active issue when concurrency policy expects one.
- Active issues stale in `In Progress`, `Human Review`, or `Merging`.
- PRs merged while Linear state or durable cleanup remains incomplete.
- Open PR checks failing, missing, or recorded for stale heads.
- Root `main` behind `origin/main`.
- Daemon stopped, stale, or running code from before `main` advanced.
- Stale workspace locks, stale worktrees, retry drift, or dirty source state
  outside ignored runtime artifacts.
- Local issue branches with committed work not pushed to origin.
- Validation, handoff, or PR body artifacts present with no recorded PR.
- `agent_pr_creation_failed` after a successful commit.
- Approval/review metadata drift that needs a trusted Linear supervisor decision
  with PR head SHA, validation, CI, findings, and decision summary.
- `Merging` issues bounced for unapproved automated review should be in the
  configured needs-input state, usually `Human Review`, with a comment asking
  for a structured `AgentOS-Human-Decision`. CI/check/mergeability bounces may
  return to `In Progress` for repair and should include the failing PR/check
  reason. They should also show a repair/fix issue-state phase rather than an
  approved-review landing state.
