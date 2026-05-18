# Linear Setup Runbook

## Control-Plane Model

AgentOS uses Linear in Symphony style: Linear owns work selection and
monitoring, while the local orchestrator owns polling, workspace creation,
Codex App Server runs, and retry timing. Tracker write ownership is configured
through `lifecycle.mode`; the safe default is `orchestrator-owned`, where the
orchestrator also owns state moves and lifecycle comments.

Put an issue in a configured active state and run the local orchestrator:

```bash
bin/agent-os orchestrator run --repo <repo> --workflow WORKFLOW.md
```

The repository harness is still the quality contract. `AGENTS.md`,
`WORKFLOW.md`, `ARCHITECTURE.md`, skills, and `scripts/agent-check.sh` keep the
Linear-launched work grounded.

## Company Workspace Login

1. Connect or switch the Linear integration to the company workspace.
2. Set `LINEAR_API_KEY` for local CLI use if using API-key mode.
3. Run:

```bash
bin/agent-os linear teams
bin/agent-os linear doctor --team <team-key-or-id>
bin/agent-os codex-doctor
```

4. Seed the roadmap into the primary solo-founder team:

```bash
bin/agent-os linear seed-roadmap --team <team-key-or-id> --project AgentOS
```

Only the first roadmap issue should start in the active state; later issues stay
out of that state until the previous item is complete.

## Planned Child/Follow-Up Issues

After a supervisor approves a decomposition plan, create or update generated
issues from a repo-local YAML/JSON plan file:

```bash
scripts/agent-linear-plan-issues.sh --file .agent-os/planned-issues.yml --parent VER-53 --state Todo
```

Plan entries may use `child_issues`, `follow_up_issues`, or mixed `issues`.
Each entry should include a stable `marker`, `title`, compact `scope`, and a
small `acceptance_criteria` list. The helper reuses existing generated issues by
marker, inherits the parent assignee unless an assignee or trusted actor is set,
and writes requested `blocked_by`/`unblocks` relationships.

Use this as one workflow with the planning guidance, not as a separate
bookkeeping shortcut:

1. Capture the approved decomposition plan in the parent issue or a repo-local
   plan artifact.
2. Run `scripts/agent-linear-plan-issues.sh` against that plan so every child
   has a stable idempotency marker, compact active scope, and any requested
   `blocked_by`/`unblocks` relation.
3. Leave blocked children in an active state only when their Linear dependency
   relations are accurate. AgentOS dispatch eligibility is issue-driven: a
   child with a nonterminal `blocked_by` issue is skipped even when local PR
   metadata or GitHub checks look ready.
4. Let completed dependencies become eligible through Linear state changes.
   A blocked child becomes dispatchable when every `blocked_by` relation is in
   a configured terminal state such as `Done`, `Closed`, `Canceled`, or
   `Duplicate`.

## Parent Closeout Evidence

Before closing a decomposed parent issue, record a compact closeout note in the
parent handoff or a linked proof artifact. Include:

- Child issue links and their final Linear states.
- The primary PR for each child, whether it merged, and the head SHA used for
  validation.
- The validation evidence path for each child, including any focused checks and
  the final `npm run agent-check` result.
- Current `main` and selected PR head agreement, or an explicit follow-up when
  local validation and GitHub CI disagree.
- Clean root worktree status plus workspace cleanup/reconciliation after any
  daemon restart needed for closeout.
- Advisory review-budget split telemetry, if present, as historical context
  only when the child is terminal in Linear and the selected PR is merged.

## Live AgentOS Project

- Workspace/team: `VerityStudio` (`VER`)
- Project: `AgentOS`
- URL: https://linear.app/veritystudio/project/agentos-08cea1e6f2f8
- Active states in this workspace: `Todo`, `In Progress`
- Handoff state: `Human Review`
- Merge shepherding state: `Merging`
- Terminal states: `Done`, `Closed`, `Canceled`, `Duplicate`
- Seeded roadmap: `VER-5` through `VER-21`

This workspace intentionally uses `Canceled` only. Do not add spelling variants
for the same state.

## Linear Lifecycle

In the default `orchestrator-owned` lifecycle mode, the orchestrator performs the
Linear lifecycle:

- active states, `Todo` and `In Progress`, are the queue/continuation lane
- running state, for example `In Progress`, means AgentOS picked it up
- retry comments show automatic retry timing and error text
- `Human Review` means Codex completed the run or the retry budget needs human attention
- `Merging` is the human approval signal for AgentOS to check GitHub, squash-merge, delete the branch, and move the issue to `Done`

Codex writes `.agent-os/handoff-<issue>.md`; AgentOS posts that file as the
final Linear comment before moving the issue to review. Handoffs must include one
machine-readable outcome line:

```text
AgentOS-Outcome: implemented
AgentOS-Outcome: partially-satisfied
AgentOS-Outcome: already-satisfied
```

For `already-satisfied`, Codex should make no code changes, run validation, and
write the no-op handoff. AgentOS persists that state and moves the issue to
`Human Review` for confirmation rather than directly marking it `Done`.

Issues do not always need PRs. Investigation-only and planning-only issues may
finish with a handoff-only result, while code/docs issues may list one or many
PR URLs. AgentOS records PR outputs in optional `prs[]`; legacy `prUrl` is only
the first-PR compatibility mirror. In multi-PR handoffs, label URLs as
`Primary PR:`, `Supporting PR:`, `Docs PR:`, `Follow-up PR:`, or
`Do not merge PR:` so automated review and merge target selection are explicit.
By default AgentOS reviews merge-eligible `primary` and `docs` PRs and only
merges the selected primary merge target; supporting, follow-up, and
do-not-merge PRs are review-only metadata.

When merge shepherding succeeds or discovers that the selected PR is already
merged, the issue can move to `Done` even if branch cleanup is incomplete.
AgentOS removes the issue worktree before deleting a local `agent/*` branch,
deletes the matching remote branch only when safe, tolerates already-absent
remote branches, and records cleanup warnings instead of scheduling an
implementation retry.

The orchestrator persists runtime state in `.agent-os/state/runtime.json`.
After a restart it rebuilds due retries, cancels or marks stale orphaned
running summaries, releases stale workspace locks, clears retry metadata for
terminal or already-merged issues, and logs a startup recovery summary. If the
long-running daemon sees `main` advance after it started, it logs a freshness
warning so the operator can restart onto the self-modifying AgentOS code.

For `hybrid` and experimental `agent-owned` projects, agents can use the
repo-local Linear lifecycle wrappers instead of MCP tracker writes:

```bash
scripts/agent-linear-comment.sh VER-46 --event status_update --file .agent-os/status.md
scripts/agent-linear-move.sh VER-46 "Human Review"
scripts/agent-linear-pr.sh VER-46 https://github.com/org/repo/pull/46
scripts/agent-linear-handoff.sh VER-46 --file .agent-os/handoff-VER-46.md
```

Configure the matching `lifecycle.allowed_tracker_tools`, marker format,
allowed transitions, duplicate-comment behavior, and fallback behavior before
enabling those modes. `orchestrator-owned` remains the default and does not
allow agent tracker writes through these lifecycle wrappers.
Lifecycle file inputs must stay inside the repository, and handoff posting reads
the resolved issue's `.agent-os/handoff-<issue>.md` artifact. The wrappers use a
trusted AgentOS CLI from `AGENT_OS_SOURCE_REPO` or `PATH`, keep `WORKFLOW.md` as
the repo-local policy source, and accept only current-repository GitHub PR URLs
for lifecycle PR metadata.
