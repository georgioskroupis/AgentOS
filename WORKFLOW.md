---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: AgentOS
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Done
    - Canceled
    - Duplicate
  running_state: In Progress
  review_state: Human Review
  merge_state: Merging
  needs_input_state: Human Review
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
  max_retry_attempts: 3
  max_retry_backoff_ms: 300000
codex:
  command: npx codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
github:
  command: gh
  merge_method: squash
  require_checks: true
  delete_branch: true
  done_state: Done
---

# AgentOS Workflow

## Toolkit Lifecycle

1. Edit shared templates or skills in this repository.
2. Run `npm run agent-check`.
3. Apply the harness to a target project with `bin/agent-os init <repo>`.
4. Validate the target project with `bin/agent-os doctor <repo>`.
5. Run target checks with `bin/agent-os check <repo>`.

## Target Repository Lifecycle

The live AgentOS Linear project uses:

- Todo
- In Progress
- Human Review
- Merging
- Done
- Closed
- Canceled
- Duplicate

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
- Attempt: {{ attempt | default: 0 }}

Responsibilities:

1. Work in the isolated workspace provided by AgentOS.
2. Make the smallest coherent change that satisfies the issue.
3. Run `npm run agent-check`.
4. Open or update a GitHub PR when validation passes.
5. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with summary, validation, risks, and PR link.
6. Do not move or comment on the Linear issue directly; the AgentOS orchestrator owns Linear lifecycle updates.
