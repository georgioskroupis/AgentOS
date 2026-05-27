# Product Notes

AgentOS helps convert agent-assisted development from ad hoc prompting into a
repeatable operating system:

- project harnesses make repositories legible to agents
- validation scripts make quality executable
- reusable skills make good workflows portable
- Linear-backed orchestration can assign eligible issues continuously

The product promise is simple:

- Any project can run `agent-os init`, `agent-os doctor`, and `agent-os check`.
- Any registered Linear project can be polled by the Symphony-style
  orchestrator, worked in an isolated workspace, validated by the harness, and
  handed back for human review.
- Any `agent-os.yml` registry can run registry-wide orchestration across
  projects with global/per-project concurrency, fair scheduling, project-local
  workflow config, and registry status summaries for operator triage.

Monitor optimization planning is tracked in
[`MONITOR_OPTIMIZATION_GAP_INVENTORY.md`](MONITOR_OPTIMIZATION_GAP_INVENTORY.md).

<!-- AGENTOS:BEGIN -->
## AgentOS Product Context

Project: agent-os.

Product context was inferred from the existing repository. Refine this section as product decisions become clearer.

Validation posture: npm lint, format, coverage, typecheck, tests, build, architecture, docs, security, dashboard, and contract checks are available through repo-local scripts. Full `agent-check` requires `node_modules`; run `npm ci` before full validation.
<!-- AGENTOS:END -->
