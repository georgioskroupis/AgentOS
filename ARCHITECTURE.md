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
- `src/agent-lifecycle.ts` provides repo-local Linear lifecycle tool policy for
  hybrid and experimental agent-owned modes.
- `src/github.ts` shells through `gh` for PR status and squash merge.
- `src/issue-state.ts` stores durable per-issue PR metadata.
- `src/runtime-state.ts` stores durable active-run, retry-queue, claimed-issue,
  daemon freshness, and startup recovery state.
- `src/workspace.ts` creates deterministic per-issue workspaces.
- `src/runner/app-server.ts` targets Codex App Server through JSON-RPC.
- `src/orchestrator.ts` schedules issues, runs agents, reconciles state, and
  records observability events.

## Boundaries

- Template files should not depend on this repository after installation.
- Shared skills should be reusable across project types.
- CLI behavior should be conservative and avoid overwriting user files.
- Lifecycle ownership is explicit in `WORKFLOW.md`. The current safe default is
  `orchestrator-owned`, where the orchestrator reads tracker state, starts
  runs, moves Linear issues, and posts lifecycle comments. `hybrid` and
  experimental `agent-owned` are source-alignment modes with stricter validation
  requirements. Codex writes repo changes and handoff files.
- Merge shepherding is a separate orchestrator path: `Merging` issues do not
  start Codex; they use stored PR metadata and GitHub checks to merge or return
  to `Human Review`.
- Linear pagination, dependency blocking, retries, and successful unchanged
  issue suppression are code paths, not prose-only policy.

<!-- AGENTOS:BEGIN -->
## AgentOS Architecture Notes

Repository implements reusable harness and orchestration tooling for agent-assisted software projects.
Architecture is organized into harness, enforcement, orchestration, and replication layers.
Primary TypeScript source is under src/.
bin/agent-os is the CLI entrypoint and runs via tsx when available, otherwise dist/cli.js.
templates/base-harness contains reusable repository harness files copied into target projects.
templates/profiles contains profile-specific additions for api, web, python, and typescript projects.
skills contains reusable agent workflows for planning, implementation, bug fixing, PR review, CI diagnostics, QA smoke validation, docs, tests, and cleanup.
src/linear.ts integrates with Linear GraphQL.
src/github.ts shells through gh for PR status and squash merge workflows.
src/runtime-state.ts persists active-run, retry-queue, claimed-issue, daemon freshness, and startup recovery state.
src/runner/app-server.ts targets Codex App Server through JSON-RPC.
src/orchestrator.ts schedules Linear issues, runs Codex agents, reconciles state, records events, runs automated review, and shepherds merges.
scripts/agent-check.sh is the primary project harness check and validates required files, shell syntax, harness contract, typecheck, tests, and build when node_modules exists.
GitHub Actions CI is present and documented as running npm ci followed by npm run agent-check.

Public surfaces: package.json scripts, package.json bin entrypoint agent-os, bin/agent-os CLI commands, src/ modules and exported TypeScript APIs, templates/base-harness/ installed harness files, templates/profiles/ profile-specific docs and quality guidance, skills/*/SKILL.md reusable workflows, scripts/agent-check.sh, scripts/check-harness-contract.mjs, scripts/agent-smoke-test.sh, scripts/agent-quality-report.sh, scripts/agent-capture-logs.sh, WORKFLOW.md orchestration configuration and prompt contract, ARCHITECTURE.md repository architecture contract, docs/ product, architecture, runbook, decision, security, generated, and quality documentation, .github/workflows/ci.yml.
<!-- AGENTOS:END -->
