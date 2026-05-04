# Rollout Runbook

## Apply AgentOS To A Project

```bash
bin/agent-os init ../my-project --profile typescript --dry-run
bin/agent-os init ../my-project --profile typescript
bin/agent-os doctor ../my-project --profile typescript
bin/agent-os check ../my-project
```

Check `lifecycle.mode` in `WORKFLOW.md` before rollout. The safe default is
`orchestrator-owned`: the orchestrator owns Linear moves and comments, while
Codex changes the repo, runs the harness check, opens or updates a PR when
needed, and writes `.agent-os/handoff-<issue>.md`.

`hybrid` keeps orchestrator-owned safety/bookkeeping moves and lifecycle markers
but expects substantive handoff/update content to be owned by agent artifacts or
tracker tools. `agent-owned` is experimental; strict workflow validation rejects
it unless tracker tools, idempotency markers, allowed transitions,
duplicate-comment behavior, fallback behavior, and the durable-recovery maturity
acknowledgement are declared.

For PR-producing work, Codex should create or find the pull request through
the repo-local non-interactive harness script:

```bash
scripts/agent-create-pr.sh \
  --title "<short title>" \
  --body-file <path-to-pr-body.md> \
  --base main \
  --head "$(git branch --show-current)" \
  --draft
```

This keeps PR creation in standard development tooling (`gh pr create`) and
avoids GitHub app/MCP PR creation paths that can ask for elicitation. If this
deterministic path fails, Codex should stop with `agent_pr_creation_failed`
instead of requesting approval or using an interactive fallback.

Every handoff starts with an implementation outcome. If the issue is already
satisfied, Codex writes `AgentOS-Outcome: already-satisfied`, makes no code
changes, and AgentOS moves the issue to `Human Review` with validation evidence.
Investigation-only and planning-only issues may also finish with a handoff and
no PR. Larger issues may list multiple PR URLs; AgentOS records them in optional
`prs[]`, while legacy `prUrl` remains only the first-PR compatibility mirror.

After human review of PR-producing issues, move the Linear issue to `Merging`.
AgentOS will require a green GitHub check, squash-merge the primary PR, delete
the branch, comment in Linear, and move the issue to `Done`.

This flow is dogfooded by the AgentOS project before being reused elsewhere.
For successful dogfood PR probes, confirm the pull request was created through
the non-interactive `gh` path before marking the probe complete.

## Register The Project

```bash
bin/agent-os project add my-project ../my-project \
  --profile typescript \
  --workflow WORKFLOW.md \
  --linear-project MyProject \
  --max-concurrency 1
```

## Start One Orchestrator Pass

```bash
bin/agent-os orchestrator once --repo ../my-project --workflow WORKFLOW.md
```

## Start Continuous Orchestration

```bash
bin/agent-os orchestrator run --repo ../my-project --workflow WORKFLOW.md
```
