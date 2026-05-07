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

It keeps orchestration logic narrow:

- Linear is the scheduler control plane.
- Lifecycle ownership is explicit. `orchestrator-owned` is the current safe
  mode, where the orchestrator is a reader/runner with retry, reconciliation,
  status moves, and Linear lifecycle comments. `hybrid` keeps orchestrator-owned
  safety/bookkeeping moves and markers while leaving substantive update content
  to agent artifacts/tools. Repo-local `scripts/agent-linear-*` wrappers provide
  marker-backed comments, allowed state moves, PR metadata persistence, and
  handoff posting for that boundary. `agent-owned` is experimental and
  strict-validation gated.
- The agent, guided by `WORKFLOW.md`, changes the repo, validates the work,
  opens or updates pull requests only when the issue produced repo changes and
  the workflow expects a PR, and writes a handoff file for the orchestrator to
  post.
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
  workspace-local review artifact path; AgentOS validates and copies those
  artifacts into the runtime review store. Blocking findings trigger focused
  fixer turns on the same PR. Failed GitHub checks are diagnosed from PR/check
  status and failed Actions logs, and CI fixer turns run only for
  `mechanical-first` failures with enough context. Non-converging, malformed,
  ambiguous, or logless failures escalate to `Human Review` with
  `reviewStatus: human_required`.
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
