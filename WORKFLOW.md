---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: AgentOS
  active_states:
    - Ready
  terminal_states:
    - Done
    - Canceled
    - Cancelled
polling:
  interval_ms: 30000
workspace:
  root: .agent-os/workspaces
hooks:
  after_create: bash "$AGENT_OS_SOURCE_REPO/scripts/agent-bootstrap-worktree.sh"
  timeout_ms: 120000
agent:
  max_concurrent_agents: 1
  max_turns: 20
  max_retry_backoff_ms: 300000
codex:
  command: npx codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

# AgentOS Workflow

## Toolkit Lifecycle

1. Edit shared templates or skills in this repository.
2. Run `npm run agent-check`.
3. Apply the harness to a target project with `bin/agent-os init <repo>`.
4. Validate the target project with `bin/agent-os doctor <repo>`.
5. Run target checks with `bin/agent-os check <repo>`.

## Target Repository Lifecycle

The generated harness expects tickets to move through:

- Ready for Agent
- In Progress by Agent
- Agent Review
- Human Review
- Needs Human Input
- Done

## Failure Behavior

If a task is blocked, the agent should report:

- blocker
- attempted steps
- smallest next human decision
- current validation state

## Agent Prompt

You are implementing Linear issue {{ issue.identifier }} in AgentOS.

Read `AGENTS.md`, `ARCHITECTURE.md`, `WORKFLOW.md`, and the issue text before editing.

Issue:
- Title: {{ issue.title }}
- State: {{ issue.state }}
- URL: {{ issue.url }}

Responsibilities:

1. Move the Linear issue to `In Progress` with `agent-os linear move {{ issue.identifier }} "In Progress"`.
2. Work in the isolated workspace provided by AgentOS.
3. Make the smallest coherent change that satisfies the issue.
4. Run `npm run agent-check`.
5. Open or update a GitHub PR when validation passes.
6. Comment on the Linear issue with summary, validation, risks, and PR link.
7. Move the issue to `In Review`.
