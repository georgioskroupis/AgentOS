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
  to agent artifacts/tools. `agent-owned` is experimental and strict-validation
  gated.
- The agent, guided by `WORKFLOW.md`, changes the repo, validates the work,
  opens or updates pull requests only when the issue produced repo changes and
  the workflow expects a PR, and writes a handoff file for the orchestrator to
  post.
- Every agent run starts with an implementation audit. Already-satisfied issues
  are reported as `AgentOS-Outcome: already-satisfied`, persisted as issue
  state, and moved to review without requiring a PR.
- Issue handoffs may carry zero, one, or many PR outputs. AgentOS treats
  optional `prs[]` as authoritative and keeps legacy `prUrl` only as a first-PR
  compatibility mirror.
- PR-producing implemented issues run through the Ralph Wiggum loop while
  Linear remains `In Progress`: self, correctness, tests, architecture, and
  conditional security reviewers write machine-readable findings to a
  workspace-local review artifact path; AgentOS validates and copies those
  artifacts into the runtime review store. Blocking findings trigger focused
  fixer turns on the same PR; non-converging or malformed reviews escalate to
  `Human Review` with `reviewStatus: human_required`.
- The merge shepherd watches `Merging`, validates GitHub PR checks, squash-merges
  safe PRs, respects Wiggum review state or an explicit Linear `Merging` human
  override, and moves Linear issues to `Done`.
- Successful unchanged issues are not re-dispatched inside the same service run;
  a Linear update or state transition is the signal for fresh work.
- `agent-os inspect <issue>` reads durable state, recent logs, PR metadata, and
  review artifacts so Linear comments remain high-level while the harness keeps
  detailed evidence locally.

## Replication Layer

`agent-os init`, `agent-os doctor`, `agent-os check`, and `agent-os.yml` make the
same operating model portable to current and future projects.

`agent-os setup <project-path>` is the friendly single-project path. It profiles
the selected folder, chooses a harness profile, creates or validates the Linear
project/workflow states, writes a tailored workflow, and prints the one
orchestrator command needed for the solo polling loop.
