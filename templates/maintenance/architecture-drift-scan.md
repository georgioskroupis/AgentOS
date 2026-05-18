# Architecture drift scan

Goal: detect implementation drift from the documented AgentOS layer boundaries
and reusable harness architecture.

Detection checklist:
- Compare `ARCHITECTURE.md`, `docs/architecture/`, and source modules under
  `src/` for new behavior that belongs in a named layer.
- Run or improve architecture checks when duplicate commands, hidden lifecycle
  policy, oversized modules, or boundary-crossing imports appear.
- Confirm templates remain portable across common repository types and do not
  depend on this source repository after installation.

Acceptance criteria:
- Make only small, behavior-preserving cleanup changes inside the scanned area.
- File follow-up issues for broad refactors or unclear architecture decisions.
- Run `npm run agent-check`.
- Handoff summarizes drift found, patches made, and deferred risks.
