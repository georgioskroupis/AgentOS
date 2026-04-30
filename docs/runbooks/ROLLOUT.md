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
