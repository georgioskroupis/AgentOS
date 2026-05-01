# AGENTS.md

## Project Operating Model

This repository is designed for agent-assisted development.

Start by reading:

- `ARCHITECTURE.md`
- `WORKFLOW.md`
- `docs/product/README.md`
- `docs/quality/QUALITY_SCORE.md`
- `docs/security/SECURITY.md`

## Default Workflow

For every code-changing task:

1. Understand the issue and restate acceptance criteria.
2. Inspect relevant docs and code before editing.
3. Audit whether the requested behavior already exists.
4. If already satisfied, make no code changes and report validation evidence.
5. Otherwise make the smallest coherent change.
6. Add or update tests.
7. Run `./scripts/agent-check.sh`.
8. Update docs if behavior, architecture, or public APIs changed.
9. When a PR is needed, use `scripts/agent-create-pr.sh` or explicit
   non-interactive `gh pr create` arguments.
10. Prepare a PR summary with what changed, why, tests run, risks, and
    follow-ups.

## Hard Rules

- Do not introduce new production dependencies without justification.
- Do not bypass type checks, tests, lint, or security checks.
- Do not silently change public behavior.
- Prefer fixing root causes over patching symptoms.
- If requirements are ambiguous, create an implementation plan before coding.
- Extend existing commands, states, templates, and modules instead of creating
  duplicate implementations.
