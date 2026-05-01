# Rollout Runbook

## Apply AgentOS To A Project

```bash
bin/agent-os init ../my-project --profile typescript --dry-run
bin/agent-os init ../my-project --profile typescript
bin/agent-os doctor ../my-project --profile typescript
bin/agent-os check ../my-project
```

The orchestrator owns Linear moves and comments. Codex should only change the
repo, run the harness check, open or update a PR, and write
`.agent-os/handoff-<issue>.md`.

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

After human review, move the Linear issue to `Merging`. AgentOS will require a
green GitHub check, squash-merge the PR, delete the branch, comment in Linear,
and move the issue to `Done`.

This flow is dogfooded by the AgentOS project before being reused elsewhere.

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
