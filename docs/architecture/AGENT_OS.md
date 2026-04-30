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

## Replication Layer

`agent-os init`, `agent-os doctor`, `agent-os check`, and `agent-os.yml` make the
same operating model portable to current and future projects.

