# AgentOS Architecture

## Harness Layer

Templates install `AGENTS.md`, workflow docs, skills, validation scripts, and
quality/security guidance into target repositories.

The base skill pack teaches the workflows AgentOS expects agents to perform
without human babysitting: planning, feature implementation, bug fixing, PR
review, CI diagnostics, QA smoke validation, docs updates, test writing, and
small cleanup.

## Enforcement Layer

`scripts/agent-check.sh` is the one command agents must run before handoff.
Profiles add language-specific expectations without requiring each project to
invent a new agent contract.

## Orchestration Layer

The orchestrator reads eligible Linear issues, creates deterministic workspaces,
renders strict prompts from `WORKFLOW.md`, launches Codex App Server runs, and
records JSONL events for status inspection.

Tracker access is adapter-backed. `tracker.kind` selects a registered adapter;
`linear` is the built-in production adapter, while tests can register fake
adapters through the same factory. Every adapter must return the normalized
Issue domain model: stable `id` and `identifier`, state name, integer-or-null
priority, ISO-8601 timestamps or null, lowercased labels, parent/child refs,
and blockers represented through inverse `blocks`/`blocked_by` relations. The
required operations are candidate fetch by active state, issue fetch by ids, and
issue state lookup by ids; comments, moves, terminal scans, and idempotent
upserts are optional capabilities used only when the workflow path needs them.

It keeps orchestration logic narrow:

- Linear is the scheduler control plane.
- Lifecycle ownership is explicit. `agent-owned` is the public source-faithful
  mode: the orchestrator is a reader/runner/reconciler, normal Linear lifecycle
  writes come from repo-local `scripts/agent-linear-*` wrappers, and scheduler
  tracker writes are limited to enumerated no-agent-can-act safety reasons.
  Those wrappers provide marker-backed comments, allowed state moves, PR
  metadata persistence, handoff posting, issue/run/attempt marker correlation,
  duplicate-comment policy, transition policy, and fallback behavior. Human
  supervisors have a separate by-identifier `agent-os supervisor` path for state
  moves and structured decisions, so operators do not need direct GraphQL or raw
  Linear UUIDs. Legacy scheduler-owned lifecycle modes are removed from public
  workflow configuration and excluded from source-faithful certification.
- The agent, guided by `WORKFLOW.md`, changes the repo, validates the work,
  opens or updates pull requests only when the issue produced repo changes and
  the workflow expects a PR, and writes a handoff file for the orchestrator to
  post.
- Before dispatch, the orchestrator emits a scope report for the
  active candidate. The report classifies existing implementation evidence as
  already satisfied, partially satisfied, missing, or unclear; estimates touched
  subsystems, docs/tests impact, PR likelihood, review risk, and likely-large
  scope; and records Linear comment, trusted human-decision,
  run/runtime/workspace/PR/validation/handoff signals. Dispatch guardrails use
  that report and durable state to refuse duplicate implementation for
  already-completed, approved, merged, terminal, or recoverably partial work,
  and to pause likely-large missing work for planning/decomposition without
  creating child issues directly.
- Every agent run starts with an implementation audit. Already-satisfied issues
  are reported as `AgentOS-Outcome: already-satisfied`, persisted as issue
  state, and moved to review without requiring a PR.
- Issue handoffs may carry zero, one, or many PR outputs. AgentOS treats
  optional `prs[]` as authoritative and keeps legacy `prUrl` only as a first-PR
  compatibility mirror. PR refs can declare roles (`primary`, `supporting`,
  `docs`, `follow-up`, `do-not-merge`) so automated review and merge
  shepherding select explicit targets.
- PR-producing implemented issues run through the Ralph Wiggum loop while
  Linear remains `In Progress`: self, correctness, tests, architecture, and
  conditional security reviewers write machine-readable findings to a
  workspace-local review artifact path; opt-in parallel reviewer runs are
  bounded by workflow config and use isolated per-reviewer writable roots.
  AgentOS validates and copies those artifacts into the runtime review store.
  Blocking findings trigger focused fixer turns on the same PR. Failed GitHub
  checks are diagnosed from PR/check status and failed Actions logs, and CI
  fixer turns run only for
  `mechanical-first` failures with enough context. Non-converging, malformed,
  ambiguous, or logless failures escalate to `Human Review` with
  `reviewStatus: human_required`.
- Review budget policy sits beside the bounded fixer loop. It evaluates elapsed
  review/fix time, review token volume, validation reruns, review and fixer
  iteration count, finding count/severity, changed-file count, repeated broad
  categories, and late new P1/P2 findings after a prior approved state. Broad
  or non-mechanical budget exhaustion records a structured split/follow-up
  recommendation. After required-reviewer approval with green validation and
  checks, that recommendation is advisory; before approval, it remains a
  blocking review-budget escalation. Narrow mechanical findings stay on the
  existing fixer path while within budget.
- The merge shepherd watches `Merging`, validates GitHub PR checks, squash-merges
  the selected primary merge target, respects Wiggum review state or an explicit
  Linear `Merging` human override, treats already-merged PRs and successful
  merge commands as authoritative, records best-effort cleanup warnings, and
  moves Linear issues to `Done`.
- Registry-wide orchestration reads `agent-os.yml`, resolves each project's
  workflow path, and runs project-local orchestrator passes under a global
  concurrency cap, per-project concurrency cap, and project runner lock. The
  registry scheduler is fair across projects: exhausted or blocked projects do
  not prevent another project from dispatching while capacity remains.
- Runtime state is schema-versioned in `.agent-os/state/runtime.json`. On
  startup, AgentOS rebuilds due retries, marks orphaned running summaries
  stale or canceled, clears retry metadata for terminal or already-merged work,
  releases stale workspace locks, reconciles issue phases to terminal truth,
  records daemon start SHA/workflow freshness, and writes a recovery summary to
  the run log.
- Successful unchanged issues are not re-dispatched inside the same service run;
  a Linear update or state transition is the signal for fresh work.
- `agent-os inspect <issue>` reads durable state, recent logs, PR metadata, and
  review artifacts so Linear comments remain high-level while the harness keeps
  detailed evidence locally.
- `agent-os status --registry` reads registry runtime summaries plus each
  project's workflow, runtime, issue state, and recent logs. It separates
  transient tracker/network failures from issue run failures, surfaces daemon
  freshness after `main` advances, shows CI/review/merge/retry waits, and
  preserves local validation timing evidence alongside GitHub CI authority.
- The optional monitor listener is disabled by default and can be enabled with
  `server.port` or `agent-os orchestrator run --port <number>`. It currently
  serves only the static lean monitor shell at the root route. Runtime snapshot
  assembly and rendering remain extension-owned future work.
- Phase timing is a durable measurement surface stored in run summaries and
  events. Operator-facing timing reports and SLO diagnostics are a separate
  reporting layer, not part of the measurement-only timing recorder.

## Replication Layer

`agent-os init`, `agent-os doctor`, `agent-os check`, and `agent-os.yml` make the
same operating model portable to current and future projects.

`agent-os setup <project-path>` is the friendly single-project path. It profiles
the selected folder, chooses a harness profile, creates or validates the Linear
project/workflow states, writes a tailored workflow, and prints the one
orchestrator command needed for the solo polling loop.
