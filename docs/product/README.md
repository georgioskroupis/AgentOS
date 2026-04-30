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

<!-- AGENTOS:BEGIN -->
## AgentOS Product Context

Project: agent-os.

Product context was inferred from the existing repository. Refine this section as product decisions become clearer.

Known validation gaps: No npm lint script found. No dedicated coverage script found. No explicit formatting check script found. agent-check skips npm typecheck, tests, and build when node_modules is not installed.
<!-- AGENTOS:END -->
