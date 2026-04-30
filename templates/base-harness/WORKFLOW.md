---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: CHANGE_ME
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
  command: npx -y @openai/codex@latest app-server
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

# WORKFLOW.md

## Ticket Lifecycle

Recommended Symphony-style statuses:

- Todo
- In Progress
- Human Review
- Merging
- Done
- Closed
- Canceled
- Duplicate

## Agent Responsibilities

When assigned a ticket:

1. Work in the isolated workspace provided by AgentOS.
2. Reproduce the issue or define the target behavior.
3. Implement the smallest coherent change.
4. Run validation.
5. Open or update a PR when validation passes.
6. Write `.agent-os/handoff-{{ issue.identifier }}.md` with summary, validation, artifacts, risks, and links.
7. Do not move or comment on the Linear issue directly; the AgentOS orchestrator owns Linear lifecycle updates.

## Failure Behavior

If blocked:

- Write the blocker, attempted steps, smallest next human decision, and current validation state in the handoff file.
- Let the AgentOS orchestrator post the handoff and move the issue to `Human Review`.

## Follow-Up Discovery

If the agent finds work outside scope, file a follow-up issue and link it from
the current ticket.

## Agent Prompt

You are implementing Linear issue {{ issue.identifier }}.

Read `AGENTS.md`, `ARCHITECTURE.md`, `WORKFLOW.md`, and the issue text before editing.

Issue:
- Title: {{ issue.title }}
- State: {{ issue.state }}
- URL: {{ issue.url }}
- Attempt: {{ attempt | default: 0 }}

Responsibilities:

1. Work in the isolated workspace provided by AgentOS.
2. Make the smallest coherent change that satisfies the issue.
3. Run `./scripts/agent-check.sh`.
4. Open or update a GitHub PR when validation passes.
5. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with summary, validation, risks, and PR link.
6. Do not move or comment on the Linear issue directly; the AgentOS orchestrator owns Linear lifecycle updates.
