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
context_budget:
  enabled: true
  max_prompt_tokens: 200000
  max_cumulative_tokens: 1000000
  large_section_tokens: 8000
validation_budget:
  enabled: true
  full_validation_command: npm run agent-check
  max_full_validation_runs_per_head: 1
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
  base: main
  merge_mode: shepherd
  merge_method: squash
  merge_target: primary
  require_checks: true
  delete_branch: true
  done_state: Done
  allow_human_merge_override: false
daemon:
  main_branch_refresh_interval_ticks: 5
review:
  enabled: true
  target_mode: merge-eligible
  max_iterations: 3
  parallel_reviewers: true
  max_concurrent_reviewers: 4
  skip_optional_reviewers_after_blocking_required: true
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
  acknowledgement that agent-owned durable recovery remains experimental.

Repo-local Linear lifecycle tools are available for source-aligned modes:

```bash
scripts/agent-linear-comment.sh <issue> --event <event> --file <comment.md>
scripts/agent-linear-move.sh <issue> "<allowed state>"
scripts/agent-linear-pr.sh <issue> <pull-request-url>
scripts/agent-linear-handoff.sh <issue> --file .agent-os/handoff-<issue>.md
scripts/agent-linear-plan-issues.sh --file .agent-os/planned-issues.yml --parent <issue> --state Todo
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

Human supervisors may use the by-identifier operator helpers in
`orchestrator-owned` mode instead of direct GraphQL or Linear UUID writes:

```bash
bin/agent-os supervisor move <identifier> <state> --repo .
bin/agent-os supervisor decide <identifier> <decision-type> \
  --validation .agent-os/validation/<identifier>.json \
  --pr-head-sha <sha> \
  --ci-state passed|failed|pending \
  --findings resolved|accepted|open \
  --summary "<short rationale>" \
  --repo .
```

Those commands require a human-readable Linear identifier, a workflow-known
target state, the exact structured decision fields below, and validation
evidence with matching issue identifier, PR head SHA, and reuse-profile
metadata. Repo-local `scripts/agent-linear-*` wrappers may also be invoked with
`--supervisor` by a human operator. Agent calls without the explicit supervisor
flag remain lifecycle-policy denied in `orchestrator-owned` mode.

Approved planning/decomposition output can use `scripts/agent-linear-plan-issues.sh`
to create or update small Linear child and follow-up issues from a repo-local
YAML/JSON plan file. Every generated issue must carry an idempotency marker,
compact `Active scope`, ignored background/context sections, a small acceptance
criteria set, inherited parent assignee or explicit assignee/trusted actor
continuity, and optional machine-readable decomposition evidence linking
siblings and the parent. The helper may write parent, `blocked_by`, and
`unblocks` relationships requested by the plan, but it does not change
scheduler behavior.

## Human Decision Re-Entry

When a Human Review issue is returned to `Todo` or `In Progress`, recent Linear
comments are included in the next prompt as re-entry context. A structured
decision is authoritative only when the comment author's stable Linear user ID
or verified email matches the issue assignee or an entry in
`lifecycle.trusted_decision_actors`; other comments stay visible as
non-authoritative context and do not change lifecycle state. Agent-authored
handoff files can record structured decisions as context, but they do not
control redispatch, merge, or supervisor-continuation guardrails.

If a `Merging` issue reaches the merge shepherd before automated review is
approved and no authoritative supervisor merge decision is recorded, AgentOS
refuses the merge and moves the issue through `tracker.needs_input_state`
(default `Human Review`). The bounce comment points back to this decision
format so a supervisor can record the intended next action without putting the
issue back through the active dispatch loop.

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

High-throughput landing is a separate switchboard for automatic approved-PR
promotion toward merge readiness. It is enabled only when `trust_mode` permits
PR/network and GitHub merge capability, `automation.profile` is
`high-throughput`, and `github.merge_mode` is `shepherd` or `auto`.
Conservative/manual defaults keep auto-ready and auto-merge behavior disabled;
partial opt-ins are treated as blocked landing until the missing gate is made
explicit.

Runtime repair remains bounded by `review.max_iterations`. Automated review
findings can trigger focused fixer turns on the existing PR, and CI failures are
diagnosed from PR/check status plus failed GitHub Actions logs. AgentOS only
attempts a CI fixer turn when `automation.repair_policy: mechanical-first`
classifies the failure as mechanical with logs available and the configured
`trust_mode` permits PR/network repair; missing logs, ambiguous requirements,
denied approval/user-input, trust-mode capability gaps, or repeated findings
escalate to `Human Review`.

Context and validation budgets are enforced before expensive repeat work:

- `context_budget` records estimated prompt size, cumulative run prompt volume,
  large included sections, and why each large section was included for
  implementation, reviewer, and fixer turns. Exceeded budgets stop the turn for
  operator action instead of retrying the same oversized prompt.
- `validation_budget` allows one full `npm run agent-check` proof per unchanged
  head by default. Additional focused checks may be recorded separately, and
  matching prior full-suite evidence may be reused only when the repo head,
  workflow/config hash, trust mode, automation profile, repair policy, and
  validation risk profile are unchanged and the local/CI evidence is still
  fresh. `status` and `inspect` report whether evidence was reused or freshly
  rerun.
- Codex usage-limit errors with explicit reset times are classified as
  `capacity-wait`; AgentOS schedules the next attempt at the reset time without
  consuming the normal retry budget.

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

Merge shepherd failures split by blocker type. Review/approval-gate failures,
including missing structured supervisor decisions for unapproved automated
review, move to `tracker.needs_input_state` so they wait for Human Review.
CI/check/mergeability failures keep the active repair lane by returning to the
configured `running_state`. AgentOS records those bounces as repair/fix state
instead of leaving an approved-review landing state behind; after repair and
fresh validation, move the issue back to `Merging`.

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
Daemon freshness checks compare the daemon's start SHA for `github.base`
(default `main`) with the refreshed `origin/<base>` SHA every
`daemon.main_branch_refresh_interval_ticks` daemon ticks and immediately after
shepherd merges. A stale daemon reports the SHA delta and the manual operator
action `git pull && bin/agent-os daemon restart`.

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
- Missing, malformed, stale, or incomplete reviewer artifacts are classified as
  reviewer-runner failures first. AgentOS retries only that reviewer while the
  bounded retry budget allows it, preserves successful reviewer artifacts, and
  reports exhausted/non-mechanical runner failures separately from blocking
  review findings.
- When `review.target_mode` is `merge-eligible`, reviewer prompts include every
  selected merge-eligible PR and exclude review-only/supporting PRs.
- If blocking findings remain, AgentOS runs a focused fixer turn on the same PR
  and repeats review up to `review.max_iterations`.
- `review.budget` adds split signals for elapsed review/fix time, review token
  volume, validation reruns, review and fixer iteration count, blocking
  finding count/severity, changed-file count, repeated broad categories, and
  late new P1/P2 findings after a prior approved state. The default mode is
  `recommend-only`; `prepare-draft` also writes a local follow-up proposal under
  `.agent-os/follow-ups/`.
- When the review budget is exceeded for broad or non-mechanical signals,
  AgentOS records a structured split/follow-up recommendation in durable status.
  If required reviewers approve and current validation/check evidence is green,
  that recommendation is advisory and does not change `reviewStatus` from
  `approved`; otherwise it remains a blocking review-budget escalation. Narrow
  mechanical findings continue through the existing bounded fixer path while
  within budget.
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
6. Capture application proof when runtime behavior is in scope. Use
   `scripts/agent-start-app.sh`, `scripts/agent-smoke-test.sh`,
   `scripts/agent-capture-logs.sh`, and `scripts/agent-capture-proof.sh` when
   the project has configured the matching app-legibility commands.
7. Open or update a GitHub PR only when the issue produced repo changes and the
   workflow expects a PR, using `scripts/agent-create-pr.sh` or an explicit
   non-interactive `gh pr create` command. Do not use GitHub app/MCP PR creation
   tools.
8. Write machine-readable validation evidence to `.agent-os/validation/{{ issue.identifier }}.json` with `schemaVersion: 1`, `issueIdentifier`, `runId` from the AgentOS run context, `repoHead` from `git rev-parse HEAD`, the AgentOS run context `reuseProfile`, final authoritative `status`, and command entries for every `npm run agent-check` attempt including `name`, `exitCode`, `startedAt`, and `finishedAt`. Historical failed attempts may be recorded when a later required validation attempt passed.
9. Write a Linear-ready handoff note to `.agent-os/handoff-{{ issue.identifier }}.md` with `AgentOS-Outcome: implemented`, `AgentOS-Outcome: partially-satisfied`, or `AgentOS-Outcome: already-satisfied`, `Validation-JSON: .agent-os/validation/{{ issue.identifier }}.json`, plus summary, validation, app proof, risks, and every PR link when PRs exist so AgentOS records them in `prs[]`. Use `App-Proof:` or `Proof-Artifact:` lines for proof files or URLs that should be visible in `agent-os inspect`.
10. Follow `lifecycle.mode`: in the current `orchestrator-owned` mode, do not
   move or comment on the Linear issue directly; the AgentOS orchestrator owns
   Linear lifecycle updates.
