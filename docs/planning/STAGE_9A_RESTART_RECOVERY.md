# Stage 9A: Durable Retry/Startup Reconstruction

This is the historical planning note for the VER-48 implementation. Keep it as
design context; current runtime behavior lives in `src/runtime-state.ts`,
`src/orchestrator.ts`, and the orchestration runbooks.

Stage 9A should happen before true multi-project daemon scheduling. The goal is
to make single-project orchestration restart behavior explicit, durable, and
testable before adding a broader scheduler.

## Planning Objective

Design the smallest durable retry and startup reconstruction model that lets
AgentOS recover safely after process exits, crashes, or operator restarts.

## Questions for the Future Agent

1. Map current durable run state.
   - What is recorded in `.agent-os/runs/<run-id>/summary.json`?
   - What is recorded in `.agent-os/runs/<run-id>/events.jsonl`?
   - What is recorded in `.agent-os/state/issues/<issue>.json`?
   - What is recorded by workspace locks?

2. Identify what restart recovery already does.
   - Which terminal workspaces are cleaned on startup?
   - Which issue state fields are reusable after restart?
   - Which Linear states can be reconciled safely today?

3. Identify what remains memory-only.
   - Running workers.
   - Claimed issues.
   - Retry queue entries.
   - Completion markers.
   - Merge-waiting markers.
   - Last observed worker activity.

4. Propose the smallest durable retry queue design.
   - File shape and `schemaVersion`.
   - Issue id and identifier.
   - Attempt number.
   - Last error and error category.
   - Due time.
   - Run id, workspace path, and branch/workspace key.
   - Idempotency rules for reading and writing queue entries.

5. Propose startup reconciliation behavior.
   - How to rebuild due retries.
   - How to classify runs left in `running` status.
   - How to treat Linear issues still in `In Progress`.
   - How to avoid duplicate Codex runs for the same issue.
   - How to preserve operator-visible diagnostics.

6. Propose cancellation and stale-run semantics.
   - When a run should be marked canceled.
   - When a run should be marked stale.
   - When a retry should be scheduled.
   - When human review should be required.
   - How comments should be upserted without duplicating lifecycle history.

7. Propose tests before implementation.
   - Unit tests for durable retry queue read/write/migration.
   - Orchestrator tests for restart with due retry.
   - Orchestrator tests for restart with stale running state.
   - Orchestrator tests for terminal Linear state cleanup.
   - Tests proving no duplicate dispatch for one issue after restart.

## Constraints

- Do not change production behavior during planning.
- Do not implement multi-project daemon scheduling in Stage 9A.
- Do not add a database for v0.1 unless the planning result proves files are
  insufficient.
- Preserve runtime `.agent-os/` as ignored, local state.
- Keep migration lazy and schema-versioned.

## Expected Planning Output

The planning output should be a small implementation plan with:

- Proposed JSON schemas.
- Proposed file paths.
- Reconciliation algorithm.
- Test list.
- Rollout sequence.
- Risks and open questions.
