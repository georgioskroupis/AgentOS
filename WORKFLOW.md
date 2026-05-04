---
trust_mode: danger
automation:
  profile: high-throughput
  repair_policy: mechanical-first
lifecycle:
  mode: orchestrator-owned
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
  approval_policy: never
  approval_event_policy: deny
  user_input_policy: deny
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
    networkAccess: true
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

## Lifecycle Ownership

`lifecycle.mode: orchestrator-owned` is the current safe AgentOS default and an
intentional bounded deviation from Symphony's usual tracker-write boundary. In
this mode the orchestrator owns idempotent Linear lifecycle comments and state
moves while Codex changes the repo, opens or updates PRs only when the issue
needs one, and writes handoff/validation artifacts.

Future source-aligned modes are separate from `trust_mode` and automation repair
policy:

- `hybrid`: the orchestrator keeps safety/bookkeeping state moves and lifecycle
  markers, while substantive handoff/update content is expected to be owned by
  agent-authored artifacts or tracker tools.
- `agent-owned`: experimental only. Strict workflow validation requires
  configured tracker tools, idempotency marker format, allowed transitions,
  duplicate-comment behavior, tracker-write fallback behavior, and an explicit
  acknowledgement that durable retry/startup reconstruction is not yet complete.

## Automation And Repair Policy

Automation behavior is a separate axis from trust and lifecycle ownership:

- `trust_mode` controls sandbox, network, PR/tool, merge, and user-input
  capability.
- `lifecycle.mode` controls who owns tracker state moves and lifecycle comments.
- `automation.profile` and `automation.repair_policy` describe how aggressively
  AgentOS should prefer deterministic feedback and repair loops when the
  configured trust mode already permits the needed tools.

AgentOS dogfood uses `automation.profile: high-throughput` with
`automation.repair_policy: mechanical-first` to declare the desired
Harness-aligned behavior: prefer standard repo-local tools, CI/log inspection,
review-feedback handling, and bounded mechanical fix loops before human
escalation when the failure is tool-addressable. This profile does not grant
network, tracker, merge, or approval capability by itself; generic MCP
elicitation and user-input requests remain denied by `codex` policy.

Runtime repair remains bounded by `review.max_iterations`. Automated review
findings can trigger focused fixer turns on the existing PR, and CI failures are
diagnosed from PR/check status plus failed GitHub Actions logs. AgentOS only
attempts a CI fixer turn when `automation.repair_policy: mechanical-first`
classifies the failure as mechanical with logs available; missing logs,
ambiguous requirements, denied approval/user-input, or repeated findings
escalate to `Human Review`.

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

AgentOS treats a handoff as reviewable only after the referenced
`Validation-JSON` evidence verifies successfully. Missing or failed validation
evidence is a run failure and stays in the retry/failure path instead of moving
the issue to `Human Review`. A successful Codex turn that exhausts
`agent.max_turns` without writing `.agent-os/handoff-<issue>.md` fails as
`missing_handoff`.

Stall reconciliation uses the most recent Codex event timestamp, falling back to
run start only when no events have arrived. Long-running validation or command
output should keep the run active instead of being aborted by wall-clock age.

Do not launch `agent-os orchestrator once` or `agent-os orchestrator run` from
inside an AgentOS-managed agent turn. If an issue needs follow-up or probe
issues, create/link them in the handoff and let the top-level scheduler own
dispatch.

## Issue Outcomes

Issues are the unit of work. A run may produce zero, one, or many pull requests:

- `already-satisfied` no-op: no repo changes, validation evidence, handoff-only
  result, and no PR.
- Investigation-only: findings, risks, and follow-up recommendations in the
  handoff; no PR unless the issue explicitly asks for a versioned artifact.
- Planning-only: plan or decision artifact in the handoff or repo when requested;
  no PR unless the workflow expects the plan to be committed.
- Docs/code change with one PR: open or update a PR after validation passes.
- Larger issue with multiple PRs: list every PR URL in the handoff so AgentOS
  records them in `prs[]`.
- Follow-up discovery: file or recommend follow-up issues and link them from the
  handoff.

`prs[]` is the optional, authoritative list of PR outputs for an issue and may be
empty, contain one PR, or contain multiple PRs. Legacy `prUrl` is only a
compatibility mirror of the first PR.

## PR Creation Contract

When code or docs changed and the issue expects a pull request, use the
deterministic non-interactive path:

```bash
scripts/agent-create-pr.sh \
  --title "<short title>" \
  --body-file <path-to-pr-body.md> \
  --base main \
  --head "$(git branch --show-current)" \
  --draft
```

Direct `gh pr create` is also acceptable only when it is fully non-interactive
and includes explicit `--title`, `--body` or `--body-file`, `--base`, and
`--head` arguments. Do not use GitHub app/MCP PR creation tools for AgentOS
handoffs, because they may request elicitation. If deterministic PR creation
fails, do not retry through MCP or ask for interactive approval; stop the turn
with `agent_pr_creation_failed` and include the failed command/output in the
handoff. Already-satisfied, investigation-only, or no-op issues may end without
a PR.

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

After a PR-producing run opens or updates a PR, AgentOS keeps the issue in
`In Progress` and runs automated reviewer turns before moving it to
`Human Review`.

- Required reviewers: `self`, `correctness`, `tests`, `architecture`.
- Optional reviewer: `security` when touched files involve auth, secrets,
  external APIs, config, runners, GitHub, Linear, or orchestration.
- Blocking findings use severity `P0`, `P1`, or `P2`; `P3` findings are
  suggestions and do not force another fix iteration.
- Reviewers write exactly one machine-readable artifact to the workspace-local
  path shown in the review prompt, under
  `.agent-os/reviews/<issue>/iteration-<n>/`; AgentOS validates that JSON and
  stores the canonical runtime copy.
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
6. Open or update a GitHub PR only when the issue produced repo changes and the
   workflow expects a PR, using `scripts/agent-create-pr.sh` or an explicit
   non-interactive `gh pr create` command. Do not use GitHub app/MCP PR creation
   tools.
7. Write machine-readable validation evidence to `.agent-os/validation/{{ issue.identifier }}.json` with `schemaVersion: 1`, `issueIdentifier`, `runId` from the AgentOS run context, `repoHead` from `git rev-parse HEAD`, final authoritative `status`, and command entries for every `npm run agent-check` attempt including `name`, `exitCode`, `startedAt`, and `finishedAt`. Historical failed attempts may be recorded when a later required validation attempt passed.
8. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, `Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json`, plus summary, validation, risks, and every PR link when PRs exist so AgentOS records them in `prs[]`.
9. Follow `lifecycle.mode`: in the current `orchestrator-owned` mode, do not
   move or comment on the Linear issue directly; the AgentOS orchestrator owns
   Linear lifecycle updates.
