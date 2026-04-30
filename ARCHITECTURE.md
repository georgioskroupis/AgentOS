# ARCHITECTURE.md

## Layers

AgentOS is organized into four layers:

1. Harness layer: files copied into target repositories.
2. Enforcement layer: local scripts and checks agents can run.
3. Orchestration layer: Linear-backed scheduler and issue-tracker integration.
4. Replication layer: templates and commands that apply the system repeatedly.

## Current Scope

This repository implements the harness, replication, and first orchestration
layers:

- `templates/base-harness/` is the source template.
- `templates/profiles/` adds profile-specific guidance.
- `skills/` contains reusable workflows.
- `bin/agent-os` applies and validates templates.
- `src/linear.ts` reads and updates Linear through GraphQL.
- `src/github.ts` shells through `gh` for PR status and squash merge.
- `src/issue-state.ts` stores durable per-issue PR metadata.
- `src/workspace.ts` creates deterministic per-issue workspaces.
- `src/runner/app-server.ts` targets Codex App Server through JSON-RPC.
- `src/orchestrator.ts` schedules issues, runs agents, reconciles state, and
  records observability events.

## Boundaries

- Template files should not depend on this repository after installation.
- Shared skills should be reusable across project types.
- CLI behavior should be conservative and avoid overwriting user files.
- The orchestrator reads tracker state, starts runs, moves Linear issues, and
  posts lifecycle comments. Codex writes repo changes and handoff files.
- Merge shepherding is a separate orchestrator path: `Merging` issues do not
  start Codex; they use stored PR metadata and GitHub checks to merge or return
  to `Human Review`.
- Linear pagination, dependency blocking, retries, and successful unchanged
  issue suppression are code paths, not prose-only policy.
