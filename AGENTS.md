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
2. Make the smallest coherent change.
3. Add or update validation where useful.
4. Run the narrowest relevant check, then `npm run agent-check` when present.
5. Update docs if behavior, workflow, or public commands changed.

## Hard Rules

- Keep templates portable across common repo types.
- Do not introduce production dependencies without a clear reason.
- Prefer executable checks over prose-only rules.
- Keep generated project harness files concise and easy to customize.
