# AgentOS Architecture

## Harness Layer

Templates install `AGENTS.md`, workflow docs, skills, validation scripts, and
quality/security guidance into target repositories.

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
- The orchestrator is a reader/runner with retry, reconciliation, status moves,
  and Linear lifecycle comments.
- The agent, guided by `WORKFLOW.md`, changes the repo, validates the work, opens
  pull requests, and writes a handoff file for the orchestrator to post.
- Every agent run starts with an implementation audit. Already-satisfied issues
  are reported as `AgentOS-Outcome: already-satisfied`, persisted as issue
  state, and moved to review without requiring a PR.
- The merge shepherd watches `Merging`, validates GitHub PR checks, squash-merges
  safe PRs, and moves Linear issues to `Done`.
- Successful unchanged issues are not re-dispatched inside the same service run;
  a Linear update or state transition is the signal for fresh work.

## Replication Layer

`agent-os init`, `agent-os doctor`, `agent-os check`, and `agent-os.yml` make the
same operating model portable to current and future projects.
