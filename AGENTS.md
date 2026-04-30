# AGENTS.md

## Project Operating Model

This repository builds reusable harness and orchestration tooling for
agent-assisted software projects.

Start by reading:

- `README.md`
- `ARCHITECTURE.md`
- `WORKFLOW.md`
- `docs/README.md`
- `docs/product/README.md`
- `docs/quality/QUALITY_SCORE.md`

## Default Workflow

For code-changing tasks:

1. Inspect the relevant docs and code before editing.
2. Audit whether the requested behavior already exists.
3. If already satisfied, make no code changes and report validation evidence.
4. Otherwise make the smallest coherent change.
5. Add or update validation where useful.
6. Run the narrowest relevant check, then `npm run agent-check` when present.
7. Update docs if behavior, workflow, or public commands changed.

## Hard Rules

- Keep templates portable across common repo types.
- Do not introduce production dependencies without a clear reason.
- Prefer executable checks over prose-only rules.
- Keep generated project harness files concise and easy to customize.
- Extend existing commands, states, templates, and modules instead of creating
  duplicate implementations.

<!-- AGENTOS:BEGIN -->
## AgentOS Project Context

AgentOS detected this as a `existing` project using the `api` profile.

Detected stack: Node.js, TypeScript, API, Commander CLI, Vitest, Linear GraphQL integration, GitHub CLI integration, Codex App Server JSON-RPC, YAML/Liquid template rendering.

Agents should audit existing behavior before editing, avoid duplicate implementations, and run the project harness before handoff.
<!-- AGENTOS:END -->
