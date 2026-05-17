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
  merge_target: primary
  require_checks: true
  delete_branch: true
  done_state: Done
  allow_human_merge_override: false
review:
  enabled: true
  target_mode: merge-eligible
  max_iterations: 3
  parallel_reviewers: false
  max_concurrent_reviewers: 1
  skip_optional_reviewers_after_blocking_required: false
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
  budget:
    enabled: true
    mode: recommend-only
    max_review_elapsed_ms: 1800000
    max_review_iterations: 3
    max_fixer_iterations: 2
    max_blocking_findings: 10
    max_p1_p2_findings: 5
    max_changed_files: 40
    max_validation_reruns: 2
    max_review_tokens: 200000
    repeated_broad_category_threshold: 2
    late_new_blocking_finding_after_approval: true
    broad_categories:
      - architecture
      - lifecycle
      - orchestration
      - status
      - workflow
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
  agent-owned durable recovery remains experimental.

Repo-local Linear lifecycle tools are available for source-aligned modes:

```bash
scripts/agent-linear-comment.sh <issue> --event <event> --file <comment.md>
scripts/agent-linear-move.sh <issue> "<allowed state>"
scripts/agent-linear-pr.sh <issue> <pull-request-url>
scripts/agent-linear-handoff.sh <issue> --file .agent-os/handoff-<issue>.md
```

Those wrappers are non-interactive, call a trusted AgentOS CLI from
`AGENT_OS_SOURCE_REPO` or `PATH`, and append the repo root, `WORKFLOW.md`, and
stable tool path after user arguments so agents cannot swap the lifecycle policy
file or tool identity. In `hybrid` and experimental `agent-owned`, configure
`lifecycle.allowed_tracker_tools`, `lifecycle.idempotency_marker_format`,
`lifecycle.allowed_state_transitions`, `lifecycle.duplicate_comment_behavior`,
and `lifecycle.fallback_behavior` to let agents own substantive comments, PR
metadata, and handoff posting. Keep `orchestrator-owned` as the default unless a
project explicitly opts into that source-aligned boundary.
Lifecycle `--file` arguments must be relative paths inside the repository, and
`record-handoff` reads only `.agent-os/handoff-<resolved issue>.md`. PR metadata
must point at GitHub pull requests in the current repository before it is stored
or posted.

## Human Decision Re-Entry

When a Human Review issue is returned to `Todo` or `In Progress`, recent Linear
comments are included in the next prompt as re-entry context. A structured
decision is authoritative only when the comment author's stable Linear user ID
or verified email matches the issue assignee or an entry in
`lifecycle.trusted_decision_actors`; other comments stay visible as
non-authoritative context and do not change lifecycle state. Agent-authored
handoff files and local/manual records can mention structured decisions as
context, but they do not control redispatch, merge, or supervisor-continuation
guardrails.

Structured decision format:

```text
AgentOS-Human-Decision: fix-findings
PR-Head-SHA: <sha>
Validation-JSON: .agent-os/validation/<issue>.json
CI-State: passed|failed|pending
Findings: resolved|accepted|open
Decision-Summary: <short rationale>
```

Allowed `AgentOS-Human-Decision` values and effects:

- `fix-findings`: records `human_continuation`; AgentOS may redispatch from an
  active state with recent Linear comments, PR feedback, and review context.
- `approve-as-is`: records `supervisor_continuation`; Codex stays paused until
  accepted risk and fresh validation/CI allow a move to `Merging`.
- `accept-risk`: records `supervisor_continuation`; remaining findings are
  treated as accepted only with explicit validation/CI evidence.
- `split-follow-up`: records `supervisor_continuation`; link the follow-up
  issue in the comment or handoff before merge progression.
- `proceed-to-merge-after-supervisor-fix`: records `externally_fixed`; stale
  active runs and retries are suppressed, and merge shepherding should proceed
  only after fresh validation and green CI.

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

Runtime repair stays bounded by `review.max_iterations`. Automated review
findings may trigger focused fixer turns on the existing PR. CI repair is only
attempted under `automation.repair_policy: mechanical-first` when failed
GitHub Actions logs classify the failure as mechanical and the configured
`trust_mode` permits PR/network repair; missing logs, ambiguous requirements,
denied approval/user-input, trust-mode capability gaps, or repeated findings
escalate to human review.

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
7. Capture application proof when runtime behavior is in scope. Use
   `scripts/agent-start-app.sh`, `scripts/agent-smoke-test.sh`,
   `scripts/agent-capture-logs.sh`, and `scripts/agent-capture-proof.sh` when
   the project has configured the matching app-legibility commands.
8. Open or update a PR only when the issue produced repo changes and the
   workflow expects a PR.
9. Write `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, `Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json`, plus summary, validation, artifacts, app proof, risks, and PR links when PRs exist. Use `App-Proof:` or `Proof-Artifact:` lines for proof files or URLs that should be visible in `agent-os inspect`.
10. Follow `lifecycle.mode`: in the default `orchestrator-owned` mode, do not
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

Stall reconciliation uses the most recent Codex event timestamp, falling back to
run start only when no events have arrived. Long-running validation or command
output should keep the run active instead of being aborted by wall-clock age.

Do not launch `agent-os orchestrator once` or `agent-os orchestrator run` from
inside an AgentOS-managed agent turn. If an issue needs follow-up or probe
issues, create/link them in the handoff and let the top-level scheduler own
dispatch.

## Issue Outcomes

Issues are the unit of work. PRs are optional outputs. A run may produce zero, one, or many pull requests:

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
Each PR may carry a role: `primary`, `supporting`, `docs`, `follow-up`, or
`do-not-merge`. Unannotated handoffs default the first PR to `primary` and later
PRs to `supporting`; lines such as `Primary PR:`, `Docs PR:`, `Follow-up PR:`,
or `Do not merge PR:` are parsed as explicit roles.
Review targets are selected by `review.target_mode`: the default
`merge-eligible` reviews `primary` and `docs` PRs, while `primary` reviews only
the configured primary PR. Merge shepherding uses `github.merge_target:
primary`; it selects the `primary` PR, or the only merge-eligible PR when there
is exactly one. `supporting`, `follow-up`, and `do-not-merge` PRs are never
merged by the shepherd.

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
- `review.parallel_reviewers` may opt into bounded read-only fan-out with
  `review.max_concurrent_reviewers`; conservative workflows keep the sequential
  path.
- Blocking findings use severity `P0`, `P1`, or `P2`; `P3` findings are
  suggestions and do not force another fix iteration.
- Reviewers write exactly one machine-readable artifact to the workspace-local
  path shown in the review prompt, under
  `.agent-os/reviews/<issue>/iteration-<n>/`; parallel reviewers receive
  isolated per-reviewer writable roots. AgentOS validates that JSON and stores
  the canonical runtime copy.
- When `review.target_mode` is `merge-eligible`, reviewer prompts include every
  selected merge-eligible PR and exclude review-only/supporting PRs.
- If blocking findings remain, AgentOS runs a focused fixer turn on the same PR
  and repeats review up to `review.max_iterations`.
- `review.budget` records split signals for long review/fix time, review token
  volume, validation reruns, review and fixer iteration count, finding
  count/severity, changed-file count, repeated broad categories, and late new
  P1/P2 findings after a prior approved state. `recommend-only` records a
  structured split/follow-up recommendation; `prepare-draft` also writes a
  local proposal under `.agent-os/follow-ups/`.
- Broad or non-mechanical budget exhaustion recommends split/follow-up work
  instead of another generic review escalation. Narrow mechanical findings
  continue through the bounded fixer path while within budget.
- If review cannot converge, AgentOS moves to `Human Review` with
  `reviewStatus: human_required` and a Linear comment explaining why.

## Merge Cleanup

The merge shepherd treats a successful merge command or an already-merged
selected PR as authoritative. Branch and workspace cleanup are best-effort
follow-up steps: AgentOS removes the issue worktree before deleting a local
`agent/*` branch, deletes the remote branch only for safe AgentOS-managed branch
refs, tolerates already-absent remote branches, records cleanup warnings in
issue state and Linear comments, and still moves or keeps the issue in `Done`.

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
6. Capture application proof when runtime behavior is in scope. Use
   `scripts/agent-start-app.sh`, `scripts/agent-smoke-test.sh`,
   `scripts/agent-capture-logs.sh`, and `scripts/agent-capture-proof.sh` when
   the project has configured the matching app-legibility commands.
7. Open or update a GitHub PR only when the issue produced repo changes and the
   workflow expects a PR, using `scripts/agent-create-pr.sh` or an explicit
   non-interactive `gh pr create` command. Do not use GitHub app/MCP PR creation
   tools.
8. Write machine-readable validation evidence to `.agent-os/validation/{{ issue.identifier }}.json` with `schemaVersion: 1`, `issueIdentifier`, `runId` from the AgentOS run context, `repoHead` from `git rev-parse HEAD`, final authoritative `status`, and command entries for every `./scripts/agent-check.sh` attempt including `name`, `exitCode`, `startedAt`, and `finishedAt`. Historical failed attempts may be recorded when a later required validation attempt passed.
9. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, `Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json`, plus summary, validation, app proof, risks, and every PR link when PRs exist so AgentOS records them in `prs[]`. Use `App-Proof:` or `Proof-Artifact:` lines for proof files or URLs that should be visible in `agent-os inspect`.
10. Follow `lifecycle.mode`: in the default `orchestrator-owned` mode, do not
   move or comment on the Linear issue directly; the AgentOS orchestrator owns
   Linear lifecycle updates.
