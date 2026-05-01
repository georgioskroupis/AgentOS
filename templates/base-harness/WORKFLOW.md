---
trust_mode: ci-locked
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
  command: npx -y @openai/codex@0.125.0 app-server
  approval_event_policy: deny
  user_input_policy: deny
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
github:
  command: gh
  merge_mode: manual
  merge_method: squash
  require_checks: true
  delete_branch: true
  done_state: Done
  allow_human_merge_override: false
review:
  enabled: true
  max_iterations: 3
  required_reviewers:
    - self
    - correctness
    - tests
    - architecture
  optional_reviewers:
    - security
  require_all_blocking_resolved: true
  blocking_severities:
    - P0
    - P1
    - P2
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
2. Audit whether the acceptance criteria are already satisfied before editing.
3. If already satisfied, make no code changes, run validation, and write
   `AgentOS-Outcome: already-satisfied` in the handoff file.
4. If partially satisfied, preserve the existing implementation and change only
   the missing delta.
5. Implement the smallest coherent change only when work is still needed.
6. Run validation.
7. Open or update a PR when code or docs changed and validation passes.
8. Write `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, plus summary, validation, artifacts, risks, and links.
9. Do not move or comment on the Linear issue directly; the AgentOS orchestrator owns Linear lifecycle updates.

## Failure Behavior

If blocked:

- Write the blocker, attempted steps, smallest next human decision, and current validation state in the handoff file.
- Let the AgentOS orchestrator post the handoff and move the issue to `Human Review`.

## Follow-Up Discovery

If the agent finds work outside scope, file a follow-up issue and link it from
the current ticket.

## Duplicate-Work Guardrail

The first step of every run is an implementation audit:

- Search for existing commands, modules, states, docs, tests, and workflow
  concepts before adding new ones.
- Prefer extending the established path over creating a parallel one.
- Treat already-satisfied acceptance criteria as a no-op handoff, not an
  invitation to rewrite.

## Ralph Wiggum Review Loop

After a run opens or updates a PR, AgentOS keeps the issue in `In Progress` and
runs automated reviewer turns before moving it to `Human Review`.

- Required reviewers: `self`, `correctness`, `tests`, `architecture`.
- Optional reviewer: `security` when touched files involve auth, secrets,
  external APIs, config, runners, GitHub, Linear, or orchestration.
- Blocking findings use severity `P0`, `P1`, or `P2`; `P3` findings are
  suggestions and do not force another fix iteration.
- Reviewers write machine-readable artifacts under
  `.agent-os/reviews/<issue>/iteration-<n>/`.
- If blocking findings remain, AgentOS runs a focused fixer turn on the same PR
  and repeats review up to `review.max_iterations`.
- If review cannot converge, AgentOS moves to `Human Review` with
  `reviewStatus: human_required` and a Linear comment explaining why.

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
2. Audit whether the acceptance criteria are already satisfied before editing.
3. If already satisfied, make no code changes, run `./scripts/agent-check.sh`,
   and write a handoff with `AgentOS-Outcome: already-satisfied`.
4. If partially satisfied, preserve the existing implementation and change only
   the missing delta.
5. Run `./scripts/agent-check.sh`.
6. Open or update a GitHub PR when code or docs changed and validation passes.
7. Write machine-readable validation evidence to `.agent-os/validation/{{ issue.identifier }}.json` with `schemaVersion: 1`, `issueIdentifier`, `status`, and command entries for `./scripts/agent-check.sh` including `name`, `exitCode`, `startedAt`, and `finishedAt`.
8. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, `Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json`, plus summary, validation, risks, and PR link when a PR exists.
9. Do not move or comment on the Linear issue directly; the AgentOS orchestrator owns Linear lifecycle updates.
