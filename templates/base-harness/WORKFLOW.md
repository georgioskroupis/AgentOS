---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: CHANGE_ME
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
  command: npx -y @openai/codex@latest app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

# WORKFLOW.md

## Ticket Lifecycle

Eligible statuses:

- Ready for Agent
- In Progress by Agent
- Agent Review
- Human Review
- Needs Human Input
- Done

## Agent Responsibilities

When assigned a ticket:

1. Move the ticket to `In Progress by Agent`.
2. Create or reuse an isolated workspace.
3. Create a branch named `agent/<ticket-id>-short-title`.
4. Reproduce the issue or define the target behavior.
5. Implement the change.
6. Run validation.
7. Open or update a PR.
8. Add a ticket comment with summary, validation, artifacts, risks, and links.
9. Move the ticket to `Human Review`.

## Failure Behavior

If blocked:

- Comment with the blocker.
- Include attempted steps.
- Suggest the smallest next human decision.
- Move the ticket to `Needs Human Input`.

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

Responsibilities:

1. Move the Linear issue to `In Progress` with `agent-os linear move {{ issue.identifier }} "In Progress"`.
2. Work in the isolated workspace provided by AgentOS.
3. Make the smallest coherent change that satisfies the issue.
4. Run `./scripts/agent-check.sh`.
5. Open or update a GitHub PR when validation passes.
6. Comment on the Linear issue with summary, validation, risks, and PR link.
7. Move the issue to `In Review`.
