# Linear Setup Runbook

## Control-Plane Model

AgentOS uses Linear in Symphony style: Linear owns work selection and monitoring,
while the local orchestrator owns polling, workspace creation, Codex App Server
runs, retry timing, state moves, and lifecycle comments.

Put an issue in a configured active state and run the local orchestrator:

```bash
bin/agent-os orchestrator run --repo <repo> --workflow WORKFLOW.md
```

The repository harness is still the quality contract. `AGENTS.md`,
`WORKFLOW.md`, `ARCHITECTURE.md`, skills, and `scripts/agent-check.sh` keep the
Linear-launched work grounded.

## Company Workspace Login

1. Connect or switch the Linear integration to the company workspace.
2. Set `LINEAR_API_KEY` for local CLI use if using API-key mode.
3. Run:

```bash
bin/agent-os linear teams
bin/agent-os linear doctor --team <team-key-or-id>
bin/agent-os codex-doctor
```

4. Seed the roadmap into the primary solo-founder team:

```bash
bin/agent-os linear seed-roadmap --team <team-key-or-id> --project AgentOS
```

Only the first roadmap issue should start in the active state; later issues stay
out of that state until the previous item is complete.

## Live AgentOS Project

- Workspace/team: `VerityStudio` (`VER`)
- Project: `AgentOS`
- URL: https://linear.app/veritystudio/project/agentos-08cea1e6f2f8
- Active states in this workspace: `Todo`, `In Progress`
- Handoff state: `Human Review`
- Merge shepherding state: `Merging`
- Terminal states: `Done`, `Closed`, `Canceled`, `Duplicate`
- Seeded roadmap: `VER-5` through `VER-21`

This workspace intentionally uses `Canceled` only. Do not add a separate
`Cancelled` state.

## Linear Lifecycle

The orchestrator, not Codex, performs the Linear lifecycle:

- active states, `Todo` and `In Progress`, are the queue/continuation lane
- running state, for example `In Progress`, means AgentOS picked it up
- retry comments show automatic retry timing and error text
- `Human Review` means Codex completed the run or the retry budget needs human attention
- `Merging` is the human approval signal for AgentOS to check GitHub, squash-merge, delete the branch, and move the issue to `Done`

Codex writes `.agent-os/handoff-<issue>.md`; AgentOS posts that file as the
final Linear comment before moving the issue to review. Handoffs must include one
machine-readable outcome line:

```text
AgentOS-Outcome: implemented
AgentOS-Outcome: partially-satisfied
AgentOS-Outcome: already-satisfied
```

For `already-satisfied`, Codex should make no code changes, run validation, and
write the no-op handoff. AgentOS persists that state and moves the issue to
`Human Review` for confirmation rather than directly marking it `Done`.
