# Migration Notes

AgentOS migrations should be lazy, reversible, and safe for local runtime state.

## Runtime State

- Runtime files under `.agent-os/` are gitignored by default.
- Durable JSON state should include `schemaVersion` before it becomes part of a
  public contract.
- Readers should preserve legacy fields long enough to support existing local
  runs, then write the current shape on the next state update.

## Validation

- Full validation is the default contract for handoff.
- `scripts/agent-check.sh --structure-only` is the only mode that may skip
  dependency-backed checks.
- Future validation evidence is JSON-first so the orchestrator can verify issue,
  run, command, timestamp, and exit-code metadata mechanically.
