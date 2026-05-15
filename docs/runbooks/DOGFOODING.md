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
GitHub merge command configuration, or Codex command configuration are missing.
Use `bin/agent-os status --registry` or `bin/agent-os inspect <issue> --repo .`
to see the recorded preflight and next safe action.

For local continuous dogfood, use the durable launch helper instead of a bare
`nohup` process:

```bash
bin/agent-os daemon launch-command --repo . --workflow WORKFLOW.md
bin/agent-os daemon status --repo .
```

The command runs in a detached `screen` session, records `.agent-os/daemon.pid`,
and appends `.agent-os/daemon.log`. If a launch leaves a stale PID or empty log,
`daemon status`, `status`, and `inspect` should name the precise cleanup and
restart action.

Before returning a stalled or exhausted issue to an active state, inspect it:

```bash
bin/agent-os inspect <issue> --repo .
```

If the output reports recoverable partial work, resume the existing workspace,
preserve the dirty or unpushed branch, rerun validation, and commit/push before
updating the handoff or PR. Do not start a duplicate implementation until the
existing workspace and PR state have been reconciled.

If the output reports `planning_required`, create or attach a planning or
decomposition artifact, or split the work into follow-up issues, before
returning the issue to implementation. The orchestrator owns the pause and
Linear bookkeeping; it does not create child issues directly.

## Human Review Re-Entry

Use trusted Linear comments when a supervisor needs to continue a Human Review
issue. Authoritative comments must come from the issue assignee or a configured
`lifecycle.trusted_decision_actors` entry; other comments remain prompt context
only.

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
