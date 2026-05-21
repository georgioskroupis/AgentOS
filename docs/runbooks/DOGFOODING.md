# Dogfooding AgentOS

Use this runbook for short release-candidate dogfood cycles. The goal is to
exercise the real Linear-backed single-project loop with tiny, low-risk work.

## Cycle Shape

Create 3 to 5 small Linear issues in the configured AgentOS project. Keep each
issue small enough that a single run can complete and be reviewed quickly.

Good issue types:

- Docs cleanup.
- CLI help correction.
- Small test improvement.
- README consistency fix.
- Template wording update.

Run each issue through the normal single-project flow:

```bash
npm ci
npm run agent-check
bin/agent-os workflow validate --strict
bin/agent-os codex-doctor --strict
bin/agent-os orchestrator once --repo . --workflow WORKFLOW.md
bin/agent-os inspect <issue> --repo .
bin/agent-os runs inspect <run-id> --repo .
```

## Daemon Environment Preflight

For controlled restarts, persist required daemon environment in
`.agent-os/env` inside the target repo:

```bash
LINEAR_API_KEY=lin_...
AGENT_OS_SOURCE_REPO=/path/to/agent-os
```

`agent-os orchestrator once`, `agent-os orchestrator run`, registry
orchestration, and setup load this file before workflow environment resolution.
Startup health reports whether the file is missing, malformed, stale, or
loaded, and the daemon refuses to dispatch when required Linear credentials,
GitHub merge command/authentication, or Codex command configuration are missing.
Use `bin/agent-os status --registry` or `bin/agent-os inspect <issue> --repo .`
to see the recorded preflight and next safe action.

High-throughput landing also runs a deterministic freshness preflight before
approved PR promotion or merge shepherding. The preflight reports tracker
credential availability, GitHub command/auth availability, Codex command
availability, daemon main freshness, selected PR head, validation `repoHead`,
and GitHub check head. It blocks landing when the daemon was started before
`main` advanced, validation was recorded for a different head, the check head is
missing/stale/failing, or required credentials are unavailable. Operator actions
are intentionally mechanical: authenticate `gh`, set `LINEAR_API_KEY`, restart
the daemon from current `main`, rerun validation on the selected PR head, or
wait for GitHub Actions to finish on that head.

Unchanged-head validation reuse is allowed only when the validation evidence
also carries the current validation reuse profile. That profile records the
workflow/config hash, trust mode, automation profile, repair policy, and
validation risk profile. Landing treats profile mismatches or stale reused
local/CI timestamps as a rerun requirement, and `status`/`inspect` call out
whether validation evidence was reused or freshly rerun.

Flaky CI retry is intentionally bounded. When high-throughput diagnostics
classify all failed checks for a PR head as supported flaky/retryable
same-repository GitHub Actions failures, AgentOS may request
`gh run rerun <run-id> --failed` while `agent.max_retry_attempts` remains
available. The attempt is recorded under flaky CI retry state and appears in
`status`/`inspect`. Deterministic mechanical failures use the focused fixer
path, and ambiguous/logless, external, protected-branch, or merge-queue cases
are not retried automatically.

For local continuous dogfood, use the durable launch helper instead of a bare
`nohup` process:

```bash
bin/agent-os daemon launch-command --repo . --workflow WORKFLOW.md
bin/agent-os daemon status --repo .
```

The command runs in a detached `screen` session, records `.agent-os/daemon.pid`,
and appends crash-oriented process output to `.agent-os/daemon.log` with launch
and clean-stop boundaries. Use `.agent-os/runs/agent-os.jsonl` for normal
orchestrator diagnostics; use `.agent-os/daemon.log` only when investigating
process startup, shutdown, or uncaught crashes. If a launch leaves a stale PID
or empty log, `daemon status`, `status`, and `inspect` should name the precise
cleanup and restart action.

Before returning a stalled or exhausted issue to an active state, inspect it:

```bash
bin/agent-os inspect <issue> --repo .
```

If the output reports recoverable partial work, resume the existing workspace,
preserve the dirty or unpushed branch, rerun validation, and commit/push before
updating the handoff or PR. Do not start a duplicate implementation until the
existing workspace and PR state have been reconciled.

## Dirty Source Worktree Recovery

The default worktree bootstrap hook refuses to create an agent workspace when
the source checkout is dirty. This is intentional: a dirty source checkout can
hide operator-only scratch files, unrelated changes, or secrets that should not
be copied into an agent workspace. When the hook fails before Codex starts,
AgentOS records the run as failed, clears active runtime state, moves the issue
to the configured needs-input state, and posts a recovery-needed comment with
the failing hook command.

The normal safe action is to clean the source checkout by committing, stashing,
or removing unrelated dirty files, then return the issue to an active state.
Set `AGENT_OS_ALLOW_DIRTY_WORKTREE=1` only during operator-supervised recovery
when you have inspected `git status --porcelain` and confirmed the dirty files
are irrelevant to the issue, safe to ignore, and do not need to appear in the
agent workspace. Do not use the override to include untracked source files,
secret material, generated artifacts, or unfinished operator changes in agent
workspaces; commit or otherwise handle those files explicitly first.

When the recovered branch is clean and pushed, record the recovery locally:

```bash
bin/agent-os recovery record <issue> --repo .
```

The command refuses dirty, missing, detached, unpushed, or ambiguous worktree
evidence and records the branch, handoff, validation, and proof artifacts so the
old failure remains historical in `status` and `inspect`.

If the output reports `planning_required`, create or attach a planning or
decomposition artifact, or split the work into follow-up issues, before
returning the issue to implementation. The orchestrator owns the pause and
Linear bookkeeping; it does not create child issues directly.

## Human Review Re-Entry

Use trusted Linear comments when a supervisor needs to continue a Human Review
issue. Authoritative comments must come from a stable Linear user ID or verified
email that matches the issue assignee or a configured
`lifecycle.trusted_decision_actors` entry; other comments and agent-authored
handoff decisions remain prompt context only.

Supported decision values:

- `AgentOS-Human-Decision: fix-findings` to redispatch an active issue with the
  latest comments and PR feedback.
- `AgentOS-Human-Decision: approve-as-is` to keep Codex paused while accepting
  the current handoff.
- `AgentOS-Human-Decision: accept-risk` to accept named remaining findings.
- `AgentOS-Human-Decision: split-follow-up` when remaining work is tracked in a
  linked follow-up issue.
- `AgentOS-Human-Decision: proceed-to-merge-after-supervisor-fix` after an
  external fix, fresh validation, and green CI.

Include `PR-Head-SHA`, `Validation-JSON`, `CI-State`, `Findings`, and a short
`Decision-Summary` whenever the decision can affect merge or redispatch safety.

## Checklist

For each issue, record:

- Linear comments are correctly upserted, not duplicated.
- Validation evidence exists as JSON and verifies as `passed`.
- Reused validation evidence records the current reuse profile and fresh
  local/CI timestamps; changed head, config, trust, automation, or risk profile
  means rerun before landing.
- Historical failed validation attempts are acceptable only when the final
  authoritative validation result passed.
- `runs inspect` reports the true status, thread/turn, tokens, rate limits, and
  warnings.
- Artifact hashes stay valid; `runs inspect` reports no unexpected mismatch.
- Workspace locks do not block normal reuse or cleanup.
- `.agent-os/env` is loaded when present, and missing, malformed, or placeholder
  credentials are reported as daemon preflight health rather than product
  failures.
- `daemon status` distinguishes stopped, stale-PID, empty-log failed launch,
  blocked-preflight, and healthy idle states.
- `inspect` reports dirty workspaces, unpushed commits, stale PR heads, stale CI
  heads, and one next safe action.
- Implementation prompts include an Existing Implementation Audit requirement,
  and agents report already-satisfied, partially-satisfied, or missing scope
  before editing.
- Strict trust mode does not block legitimate small work.
- Lifecycle smoke checks run in default `lifecycle.mode: orchestrator-owned`
  mode unless a test explicitly says otherwise.
- Runtime `.agent-os/` data remains ignored and uncommitted.
- The agent does not create a PR for already-satisfied work.
- Investigation-only and planning-only work may finish with a handoff and no PR.
- Larger issue probes may record multiple PRs in `prs[]`; `prUrl` remains only
  the first-PR compatibility mirror.
- PR-producing work uses `scripts/agent-create-pr.sh` or explicit
  non-interactive `gh pr create` arguments, not GitHub app/MCP PR creation.
- Agents do not start nested `agent-os orchestrator once` or
  `agent-os orchestrator run` processes from inside an AgentOS-managed turn;
  follow-up/probe issues are linked in the handoff and dispatched by the
  top-level scheduler.
- The issue reaches the expected Linear state.

## Suggested Table

| Issue | Type | Expected outcome | Linear comments | Validation JSON | Runs inspect | Workspace lock | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<issue>` | docs cleanup | no-op or PR | pass/fail | pass/fail | pass/fail | pass/fail | |
| `<issue>` | CLI help correction | already-satisfied or PR | pass/fail | pass/fail | pass/fail | pass/fail | |
| `<issue>` | test improvement | PR | pass/fail | pass/fail | pass/fail | pass/fail | |
| `<issue>` | investigation/planning | handoff-only or follow-up issue | pass/fail | pass/fail | pass/fail | pass/fail | |

## Stop Conditions

Pause the dogfood cycle and file a focused fix issue if any of these occur:

- Linear lifecycle comments duplicate instead of upserting.
- Validation JSON is missing, stale, mismatched, or unverifiable.
- `runs inspect` hides a real failure or reports stale metrics.
- Artifact hash warnings appear without an intentional artifact edit.
- Workspace locks prevent a normal single-issue run.
- Trust-mode policy blocks valid work without a clear operator path.
- PR creation falls back to MCP elicitation instead of the deterministic
  `gh`-based path.
- An agent starts a nested AgentOS orchestrator from inside a managed turn.
- Runtime `.agent-os/` data appears in tracked git changes.

## After the Cycle

Summarize the results in the next release note or planning issue. Keep fixes
small and land them before starting larger roadmap work.
