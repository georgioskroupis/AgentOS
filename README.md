# AgentOS

AgentOS is a small toolkit for making repositories agent-readable, agent-testable,
and ready for orchestration.

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
2. fetch eligible Linear issues
3. create deterministic workspaces
4. render strict prompts
5. start Codex App Server runs
6. write `.agent-os/runs/agent-os.jsonl`

### `linear seed-roadmap`

After logging into the company Linear workspace or setting `LINEAR_API_KEY`,
creates the ordered AgentOS implementation roadmap.

```bash
bin/agent-os linear teams
bin/agent-os linear seed-roadmap --team <team-key-or-id> --project AgentOS
```

## Current Integration Notes

The orchestrator targets Codex App Server. Run:

```bash
bin/agent-os codex-doctor
```

If this reports unavailable, upgrade or install a Codex build that exposes
`codex app-server` before running live orchestration.
