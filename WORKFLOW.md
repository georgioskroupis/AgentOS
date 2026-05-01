---
trust_mode: local-trusted
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
  command: npx -y @openai/codex@0.125.0 app-server
  approval_event_policy: deny
  user_input_policy: deny
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
github:
  command: gh
  merge_mode: shepherd
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
# AgentOS Workflow

<!-- AGENTOS:WORKFLOW-CONTEXT:BEGIN -->
## AgentOS Project Context

- Project name: agent-os
- Detected mode: existing
- Recommended profile: api
- Summary source: codex
- Stack: Node.js, TypeScript, API, Commander CLI, Vitest, Linear GraphQL integration, GitHub CLI integration, Codex App Server JSON-RPC, YAML/Liquid template rendering
- Validation commands: npm run agent-check, npm run typecheck, npm test, npm run build
- Architecture notes:
  - Repository implements reusable harness and orchestration tooling for agent-assisted software projects.
  - Architecture is organized into harness, enforcement, orchestration, and replication layers.
  - Primary TypeScript source is under src/.
  - bin/agent-os is the CLI entrypoint and runs via tsx when available, otherwise dist/cli.js.
  - templates/base-harness contains reusable repository harness files copied into target projects.
  - templates/profiles contains profile-specific additions for api, web, python, and typescript projects.
  - skills contains reusable agent workflows for planning, implementation, bug fixing, PR review, CI diagnostics, QA smoke validation, docs, tests, and cleanup.
  - src/linear.ts integrates with Linear GraphQL.
  - src/github.ts shells through gh for PR status and squash merge workflows.
  - src/runner/app-server.ts targets Codex App Server through JSON-RPC.
  - src/orchestrator.ts schedules Linear issues, runs Codex agents, reconciles state, records events, runs automated review, and shepherds merges.
  - scripts/agent-check.sh is the primary project harness check and validates required files, shell syntax, harness contract, typecheck, tests, and build when node_modules exists.
  - GitHub Actions CI is present and documented as running npm ci followed by npm run agent-check.
- Validation gaps:
  - No npm lint script found.
  - No dedicated coverage script found.
  - No explicit formatting check script found.
  - agent-check skips npm typecheck, tests, and build when node_modules is not installed.
<!-- AGENTOS:WORKFLOW-CONTEXT:END -->

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

## Implementation Audit

Before changing code, the agent must compare the issue acceptance criteria with
the current repository implementation.

- If the work is already satisfied, make no code changes, run validation, write
  `AgentOS-Outcome: already-satisfied` in the handoff file, and let AgentOS move
  the issue to `Human Review`.
- If the work is partially satisfied, document what already exists, implement
  only the missing delta, and write `AgentOS-Outcome: partially-satisfied`.
- If implementation work was required, write `AgentOS-Outcome: implemented`.
- Do not create duplicate modules, commands, states, or workflow concepts when an
  existing path can be extended.

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

You are implementing Linear issue {{ issue.identifier }} in AgentOS.

Read `AGENTS.md`, `ARCHITECTURE.md`, `WORKFLOW.md`, and the issue text before editing.

Issue:
- Title: {{ issue.title }}
- State: {{ issue.state }}
- URL: {{ issue.url }}
- Attempt: {{ attempt | default: 0 }}

Responsibilities:

1. Work in the isolated workspace provided by AgentOS.
2. Audit whether the acceptance criteria are already satisfied before editing.
3. If already satisfied, make no code changes, run `npm run agent-check`, and
   write a handoff with `AgentOS-Outcome: already-satisfied`.
4. If partially satisfied, preserve the existing implementation and change only
   the missing delta.
5. Run `npm run agent-check`.
6. Open or update a GitHub PR when code or docs changed and validation passes.
7. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, plus summary, validation, risks, and PR link when a PR exists.
8. Do not move or comment on the Linear issue directly; the AgentOS orchestrator owns Linear lifecycle updates.
