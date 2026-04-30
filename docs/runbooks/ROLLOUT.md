# Rollout Runbook

## Apply AgentOS To A Project

```bash
bin/agent-os init ../my-project --profile typescript --dry-run
bin/agent-os init ../my-project --profile typescript
bin/agent-os doctor ../my-project --profile typescript
bin/agent-os check ../my-project
```

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

