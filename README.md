# AgentOS

AgentOS is a small toolkit for making repositories agent-readable, agent-testable,
and ready for Linear-backed orchestration.

The first milestone is intentionally modest:

```bash
bin/agent-os init ../my-project --profile typescript
bin/agent-os doctor ../my-project --profile typescript
bin/agent-os check ../my-project
```

## Structure

- `templates/base-harness/` contains the reusable repo harness.
- `templates/profiles/` contains language and app-specific harness additions.
- `skills/` contains shared agent workflows.
- `bin/agent-os` applies and validates the harness.
- `src/` contains the TypeScript CLI, Linear adapter, workspace manager, and
  Symphony-style orchestrator.
- `docs/` captures the operating model behind the toolkit.

## Commands

### `init <repo>`

Copies the selected harness profile into a target repository without overwriting
existing files. Existing files are left in place unless `--force` is supplied.

### `doctor <repo>`

Checks whether the target repository has the expected harness files.

### `check <repo>`

Runs the target repository's `scripts/agent-check.sh` if present.

### `orchestrator once --repo <repo>`

Runs one Symphony-style scheduling pass:

1. read `WORKFLOW.md`
2. fetch paginated eligible Linear issues
3. create deterministic workspaces
4. render strict prompts
5. start Codex App Server runs
6. move/comment on Linear for start, retry, failure, and review handoff
7. persist implementation outcome and PR metadata from handoff notes
8. shepherd `Merging` issues through GitHub checks, squash merge, and `Done`
9. track retries, unchanged successful issues, and reconciliation
10. write `.agent-os/runs/agent-os.jsonl`

Continuous mode is:

```bash
bin/agent-os orchestrator run --repo <repo> --workflow WORKFLOW.md
```

### `linear seed-roadmap`

After logging into the company Linear workspace or setting `LINEAR_API_KEY`,
creates the ordered AgentOS implementation roadmap.

```bash
bin/agent-os linear teams
bin/agent-os linear doctor --team <team-key-or-id>
bin/agent-os linear seed-roadmap --team <team-key-or-id> --project AgentOS
```

## Current Integration Notes

Linear is the control plane: issues in configured active states are dispatched,
blocked issues wait for their blockers, and the orchestrator moves/comments on
the ticket for start, retry, failure, and review handoff. Codex focuses on the
repo work and writes `.agent-os/handoff-<issue>.md` for the final Linear
comment. Each handoff includes an `AgentOS-Outcome` line so already-satisfied
issues can become no-op review handoffs instead of duplicate implementations.
When you move an approved issue to `Merging`, AgentOS reads the stored PR
metadata, requires green GitHub checks, squash-merges, deletes the branch,
comments in Linear, and moves the issue to `Done`.

The runner targets Codex App Server. Run:

```bash
bin/agent-os codex-doctor
```

If this reports unavailable, upgrade or install a Codex build that exposes
`codex app-server` before running live orchestration.
