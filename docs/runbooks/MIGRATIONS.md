# Migration Notes

AgentOS migrations should be lazy, reversible, and safe for local runtime state.

## Runtime State

- Runtime files under `.agent-os/` are gitignored by default.
- Durable JSON state should include `schemaVersion` before it becomes part of a
  public contract.
- Readers should preserve legacy fields long enough to support existing local
  runs, then write the current shape on the next state update.
- Issue state lazily migrates legacy `prUrl` to `prs[]` and keeps `prUrl` only
  as the first-PR compatibility mirror while downstream code moves to `prs[]`.
  Existing PR refs that lack a role are normalized with the first PR as
  `primary` and later PRs as `supporting`; explicit handoff labels preserve
  `primary`, `supporting`, `docs`, `follow-up`, and `do-not-merge` roles.
- Run summaries live under `.agent-os/runs/<run-id>/summary.json`, include
  `schemaVersion`, and record hashes for prompt/event/handoff artifacts.
- Review artifacts are written with `schemaVersion: 1`; readers normalize older
  reviewer JSON that omitted it.
- Workspace locks live under `.agent-os/workspaces/.agent-os/locks/workspaces`
  with schema-versioned owners and are recovered when stale.
- AgentOS lifecycle comments include `agentos:event` markers so Linear comments
  can be updated in place instead of duplicated after retries or restarts.
- `runs simulate` and `runs replay` are artifact-only local modes and must not
  instantiate real Linear, GitHub, or Codex clients.

## Validation

- Full validation is the default contract for handoff.
- `scripts/agent-check.sh --structure-only` is the only mode that may skip
  dependency-backed checks.
- Future validation evidence is JSON-first so the orchestrator can verify issue,
  run, command, timestamp, and exit-code metadata mechanically.
- Validation evidence `status` is the final authoritative result. The
  `commands` array may include failed historical attempts, but each required
  validation command must have a later fresh passing attempt for the evidence to
  be accepted.

## Workflow Defaults

- New harness installs should use `trust_mode: ci-locked`,
  `automation.profile: conservative`, `automation.repair_policy: conservative`,
  `github.merge_mode: manual`, and `github.allow_human_merge_override: false`.
  That combination keeps high-throughput landing disabled: no approved-PR
  auto-promotion toward merge readiness and no auto-merge behavior.
- Codex App Server approval and user-input event policies should default to
  `deny`.
- Existing dogfood workflows may opt into `trust_mode: local-trusted` and
  `github.merge_mode: shepherd` when they intentionally need PR/network access.
  Dogfood workflows may separately opt into
  `automation.profile: high-throughput` and
  `automation.repair_policy: mechanical-first` to declare bounded repair-loop
  intent without granting additional trust capability.
- High-throughput landing requires all three gates together: a trust mode with
  PR/network and GitHub merge capability,
  `automation.profile: high-throughput`, and `github.merge_mode: shepherd` or
  `auto`. Missing gates should be treated as blocked landing instead of falling
  back to implicit auto-ready or auto-merge behavior.
- Workflows should declare `lifecycle.mode`. Missing values resolve to
  `orchestrator-owned` for backward compatibility. `agent-owned` is
  experimental and strict-validation-gated until tracker tools, idempotency,
  transitions, fallback behavior, and durable-recovery maturity are explicit.
- Codex App Server commands should be pinned. Replace
  `@openai/codex@latest app-server` with the current pinned command from
  `src/defaults.ts`.
