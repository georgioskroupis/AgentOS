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

## Checklist

For each issue, record:

- Linear comments are correctly upserted, not duplicated.
- Validation evidence exists as JSON and verifies as `passed`.
- `runs inspect` reports the true status, thread/turn, tokens, rate limits, and
  warnings.
- Artifact hashes stay valid; `runs inspect` reports no unexpected mismatch.
- Workspace locks do not block normal reuse or cleanup.
- Strict trust mode does not block legitimate small work.
- Runtime `.agent-os/` data remains ignored and uncommitted.
- The agent does not create a PR for already-satisfied work.
- The issue reaches the expected Linear state.

## Suggested Table

| Issue | Type | Expected outcome | Linear comments | Validation JSON | Runs inspect | Workspace lock | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<issue>` | docs cleanup | PR or already-satisfied | pass/fail | pass/fail | pass/fail | pass/fail | |
| `<issue>` | CLI help correction | PR | pass/fail | pass/fail | pass/fail | pass/fail | |
| `<issue>` | test improvement | PR | pass/fail | pass/fail | pass/fail | pass/fail | |

## Stop Conditions

Pause the dogfood cycle and file a focused fix issue if any of these occur:

- Linear lifecycle comments duplicate instead of upserting.
- Validation JSON is missing, stale, mismatched, or unverifiable.
- `runs inspect` hides a real failure or reports stale metrics.
- Artifact hash warnings appear without an intentional artifact edit.
- Workspace locks prevent a normal single-issue run.
- Trust-mode policy blocks valid work without a clear operator path.
- Runtime `.agent-os/` data appears in tracked git changes.

## After the Cycle

Summarize the results in the next release note or planning issue. Keep fixes
small and land them before starting larger roadmap work.
