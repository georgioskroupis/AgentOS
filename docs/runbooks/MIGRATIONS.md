# Migration Notes

AgentOS migrations should be lazy, reversible, and safe for local runtime state.

## Runtime State

- Runtime files under `.agent-os/` are gitignored by default.
- Durable JSON state should include `schemaVersion` before it becomes part of a
  public contract.
- Readers should preserve legacy fields long enough to support existing local
  runs, then write the current shape on the next state update.
- Issue state lazily migrates legacy `prUrl` to `prs[]` and keeps `prUrl` as a
  primary-PR compatibility mirror while downstream code moves to `prs[]`.
- Run summaries live under `.agent-os/runs/<run-id>/summary.json`, include
  `schemaVersion`, and record hashes for prompt/event/handoff artifacts.
- Workspace locks live under `.agent-os/workspaces/.agent-os/locks/workspaces`
  with schema-versioned owners and are recovered when stale.

## Validation

- Full validation is the default contract for handoff.
- `scripts/agent-check.sh --structure-only` is the only mode that may skip
  dependency-backed checks.
- Future validation evidence is JSON-first so the orchestrator can verify issue,
  run, command, timestamp, and exit-code metadata mechanically.

## Workflow Defaults

- New harness installs should use `trust_mode: ci-locked`,
  `github.merge_mode: manual`, and `github.allow_human_merge_override: false`.
- Codex App Server approval and user-input event policies should default to
  `deny`.
- Existing dogfood workflows may opt into `trust_mode: local-trusted` and
  `github.merge_mode: shepherd` when they intentionally need PR/network access.
- Codex App Server commands should be pinned. Replace
  `@openai/codex@latest app-server` with the current pinned command from
  `src/defaults.ts`.
