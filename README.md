# AgentOS

AgentOS is a small toolkit for making repositories agent-readable, agent-testable,
and ready for Linear-backed orchestration.

The first milestone is intentionally modest:

```bash
bin/agent-os setup ../my-project
bin/agent-os init ../my-project --profile typescript
bin/agent-os doctor ../my-project --profile typescript
bin/agent-os check ../my-project
```

## Structure

- `templates/base-harness/` contains the reusable repo harness.
- `templates/profiles/` contains language and app-specific harness additions.
- `skills/` contains shared agent workflows for planning, implementation, bug
  fixing, PR review, CI diagnostics, QA smoke validation, docs, tests, and
  cleanup.
- `bin/agent-os` applies and validates the harness.
- `src/` contains the TypeScript CLI, Linear adapter, workspace manager, and
  Symphony-style orchestrator.
- `docs/` captures the operating model behind the toolkit.

## Commands

### `init <repo>`

Copies the selected harness profile into a target repository without overwriting
existing files. Existing files are left in place unless `--force` is supplied.

### `setup <project-path>`

Runs the minimal solo-project setup wizard. It detects existing versus
greenfield projects, profiles the folder, connects or creates the Linear
project, installs a tailored harness, verifies the setup, and offers to create
the baseline commit.

Useful non-interactive shape:

```bash
bin/agent-os setup ../my-project --team VER --project "My Project"
```

Dry-run shape:

```bash
bin/agent-os setup ../my-project --dry-run --no-codex-summary
```

Offline/local-only setup shape:

```bash
bin/agent-os setup ../my-project --no-linear --no-codex-summary --no-commit
```

### `doctor <repo>`

Checks whether the target repository has the expected harness files.

Use `--workflow AGENTOS_WORKFLOW.md` when setup preserved an existing
non-AgentOS `WORKFLOW.md`.

### `workflow validate [path]`

Validates workflow front matter and prompt configuration. Use `--strict` for
production-safe defaults such as pinned Codex commands and disabled human merge
override.

### `check <repo>`

Runs the target repository's `scripts/agent-check.sh` if present.

The AgentOS repo's own `npm run agent-check` is full validation by default and
fails if dependency-backed checks cannot run. Use
`scripts/agent-check.sh --structure-only` only when you intentionally want the
required-file and contract subset.

### `orchestrator once --repo <repo>`

Runs one Symphony-style scheduling pass:

1. read `WORKFLOW.md`
2. fetch paginated eligible Linear issues
3. create deterministic workspaces
4. render strict prompts
5. start Codex App Server runs
6. move/comment on Linear for start, retry, failure, and review handoff
7. persist implementation outcome and PR metadata from handoff notes
8. run the Ralph Wiggum review/fix loop before `Human Review`
9. shepherd `Merging` issues through GitHub checks, squash merge, and `Done`
10. track retries, unchanged successful issues, startup cleanup, and reconciliation
11. write `.agent-os/runs/agent-os.jsonl` and per-run artifacts

Continuous mode is:

```bash
bin/agent-os orchestrator run --repo <repo> --workflow WORKFLOW.md
```

### `status` and `inspect`

`status` tails the global AgentOS event log. `inspect <issue>` combines durable
issue state, PR metadata, review state, recent events, and review artifacts.

```bash
bin/agent-os status --repo <repo>
bin/agent-os inspect VER-28 --repo <repo>
```

### `runs list`, `runs inspect`, `runs simulate`, and `runs replay`

`runs list` shows durable run summaries. `runs inspect <run-id>` prints run
status, session/token metrics, and warns if recorded artifact hashes no longer
match the persisted artifacts. `runs simulate` and `runs replay` are local-only:
they read/write run artifacts without constructing Linear, GitHub, or Codex
clients.

```bash
bin/agent-os runs list --repo <repo>
bin/agent-os runs inspect run_20260501_AG-1_ab12cd --repo <repo>
bin/agent-os runs simulate --repo <repo> --issue SIM-1
bin/agent-os runs replay run_20260501_SIM-1_ab12cd --repo <repo>
```

### `linear seed-roadmap`

After logging into the company Linear workspace or setting `LINEAR_API_KEY`,
creates the ordered AgentOS implementation roadmap.

```bash
bin/agent-os linear teams
bin/agent-os linear doctor --team <team-key-or-id>
bin/agent-os linear seed-roadmap --team <team-key-or-id> --project AgentOS
```

### `linear seed-maintenance`

Creates Backlog issues for recurring doc-gardening, quality score refresh,
workflow naming drift, and small refactor scans.

```bash
bin/agent-os linear seed-maintenance --team <team-key-or-id> --project AgentOS
```

## Current Integration Notes

Linear is the control plane: issues in configured active states are dispatched
and blocked issues wait for their blockers. Lifecycle ownership is explicit in
`WORKFLOW.md`. The current safe default is `lifecycle.mode:
orchestrator-owned`, where the orchestrator moves/comments on the ticket for
start, retry, failure, and review handoff. Codex focuses on the repo work and
writes `.agent-os/handoff-<issue>.md` for the final Linear comment. Each handoff
includes an `AgentOS-Outcome` line so already-satisfied issues can become no-op
review handoffs instead of duplicate implementations. AgentOS-owned lifecycle
comments include hidden `agentos:event` markers so retries and restarts update
those comments in place when Linear supports it. `hybrid` and experimental
`agent-owned` modes are available as a source-alignment path, but strict
validation gates `agent-owned` until tracker tools, idempotency, transition,
fallback, and maturity requirements are declared.
Implemented PRs now pass through automated reviewer turns for self-review,
correctness, tests, architecture, and conditional security review. Blocking
findings trigger focused fixer turns on the same PR until reviewers approve or
AgentOS escalates to Human Review with a concrete reason.
Those turns write review JSON to workspace-local `.agent-os/reviews/...` paths
that AgentOS validates and copies into canonical runtime artifacts.
Public harness defaults leave `github.merge_mode: manual`; AgentOS dogfood opts
into `shepherd`, where moving an approved issue to `Merging` lets AgentOS read
the stored PR metadata, require green GitHub checks, squash-merge, delete the
branch, comment in Linear, and move the issue to `Done`.

The runner targets Codex App Server. Run:

```bash
bin/agent-os codex-doctor
```

If this reports unavailable, upgrade or install a Codex build that exposes
`npx -y @openai/codex@0.125.0 app-server` before running live orchestration.
Use `bin/agent-os codex-doctor --workflow WORKFLOW.md --strict` to also print
the configured approval/user-input event policy and reject unpinned commands.
Run `bin/agent-os workflow validate --strict` to catch unsafe workflow drift,
including unpinned Codex commands and incompatible trust-mode/network settings.
