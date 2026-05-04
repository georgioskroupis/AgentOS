---
trust_mode: ci-locked
automation:
  profile: conservative
  repair_policy: conservative
lifecycle:
  mode: orchestrator-owned
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

## Lifecycle Ownership

`lifecycle.mode: orchestrator-owned` is the safe default for installed
harnesses. The AgentOS orchestrator owns idempotent Linear lifecycle comments
and state moves while the agent owns repository changes, validation evidence,
PR creation only when the issue needs one, and handoff artifacts.

Other modes are separate from `trust_mode` and automation repair policy:

- `hybrid`: orchestrator-owned safety/bookkeeping moves and markers, with
  substantive handoff/update content owned by agent artifacts or tracker tools.
- `agent-owned`: experimental only. Strict workflow validation requires
  tracker tools, idempotency marker format, allowed transitions,
  duplicate-comment behavior, fallback behavior, and an acknowledgement that
  durable retry/startup reconstruction is not yet complete.

## Automation And Repair Policy

Automation behavior is separate from trust and lifecycle ownership:

- `trust_mode` controls sandbox, network, PR/tool, merge, and user-input
  capability.
- `lifecycle.mode` controls tracker state moves and lifecycle comments.
- `automation.profile` and `automation.repair_policy` describe feedback-loop
  and repair-loop behavior only.

Public harnesses default to `automation.profile: conservative` and
`automation.repair_policy: conservative`. Projects may opt into
`high-throughput` and `mechanical-first` when their operator wants internal
Harness-style cheap correction loops and has configured the needed trust mode
and tools. These automation settings do not grant network, merge, tracker, or
approval/user-input capability by themselves.

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
7. Open or update a PR only when the issue produced repo changes and the
   workflow expects a PR.
8. Write `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, `Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json`, plus summary, validation, artifacts, risks, and PR links when PRs exist.
9. Follow `lifecycle.mode`: in the default `orchestrator-owned` mode, do not
   move or comment on the Linear issue directly; the AgentOS orchestrator owns
   Linear lifecycle updates.

## Failure Behavior

If blocked:

- Write the blocker, attempted steps, smallest next human decision, and current validation state in the handoff file.
- Let the AgentOS orchestrator post the handoff and move the issue to `Human Review`.

AgentOS treats a handoff as reviewable only after the referenced
`Validation-JSON` evidence verifies successfully. Missing or failed validation
evidence stays in the retry/failure path instead of moving the issue to
`Human Review`. A successful Codex turn that exhausts `agent.max_turns` without
writing `.agent-os/handoff-<issue>.md` fails as `missing_handoff`.

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
6. Open or update a GitHub PR only when the issue produced repo changes and the
   workflow expects a PR, using `scripts/agent-create-pr.sh` or an explicit
   non-interactive `gh pr create` command. Do not use GitHub app/MCP PR creation
   tools.
7. Write machine-readable validation evidence to `.agent-os/validation/{{ issue.identifier }}.json` with `schemaVersion: 1`, `issueIdentifier`, `runId` from the AgentOS run context, `repoHead` from `git rev-parse HEAD`, final authoritative `status`, and command entries for every `./scripts/agent-check.sh` attempt including `name`, `exitCode`, `startedAt`, and `finishedAt`. Historical failed attempts may be recorded when a later required validation attempt passed.
8. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, `Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json`, plus summary, validation, risks, and every PR link when PRs exist so AgentOS records them in `prs[]`.
9. Follow `lifecycle.mode`: in the default `orchestrator-owned` mode, do not
   move or comment on the Linear issue directly; the AgentOS orchestrator owns
   Linear lifecycle updates.
