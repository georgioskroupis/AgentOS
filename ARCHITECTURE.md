# ARCHITECTURE.md

## Layers

AgentOS is organized into four layers:

1. Harness layer: files copied into target repositories.
2. Enforcement layer: local scripts and checks agents can run.
3. Orchestration layer: future scheduler and issue-tracker integration.
4. Replication layer: templates and commands that apply the system repeatedly.

## Current Scope

This repository implements the harness, replication, and first orchestration
layers:

- `templates/base-harness/` is the source template.
- `templates/profiles/` adds profile-specific guidance.
- `skills/` contains reusable workflows.
- `bin/agent-os` applies and validates templates.
- `src/linear.ts` reads and updates Linear through GraphQL.
- `src/workspace.ts` creates deterministic per-issue workspaces.
- `src/runner/app-server.ts` targets Codex App Server through JSON-RPC.
- `src/orchestrator.ts` schedules issues, runs agents, reconciles state, and
  records observability events.

## Boundaries

- Template files should not depend on this repository after installation.
- Shared skills should be reusable across project types.
- CLI behavior should be conservative and avoid overwriting user files.
- The orchestrator reads tracker state and starts runs; agent-callable helper
  commands perform comments/status moves during task execution.
