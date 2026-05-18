# Quality Score

Use this rubric to make quality expectations explicit.

| Area | Target |
| --- | --- |
| Context | `AGENTS.md`, architecture, workflow, product docs, and issue prompts give agents the smallest current source of truth |
| Validation | One local command verifies common gates and handoffs record validation evidence |
| Observability | Status, logs, run artifacts, CI state, validation timing, and app proof point operators to the next safe action |
| Lifecycle | Workflow states, ownership, handoff outcomes, and tracker-write boundaries are documented and enforced |
| Review loops | Review expectations, fixer iterations, escalation paths, and accepted-risk decisions are explicit |
| Restart recovery | Dead/stalled runs, retries, stale locks, and restart recovery avoid duplicate work |
| Application legibility | Start, health, smoke, logs, metrics, traces, CI logs, and UI/browser proof are documented when applicable |
| Source alignment | Harness, skills, prompts, workflow policy, and docs stay aligned with current implementation |
| Merge cleanup health | Merged PRs, tracker state, branch cleanup, and workspace cleanup drift are visible |
| Daemon/runtime freshness | Daemon liveness, local environment, root `main`, `origin/main`, and runtime freshness are checked when applicable |
| Monitor automation health | Recurring maintenance checks catch stale docs, runbooks, architecture, skills, prompts, workspaces, locks, retries, PRs, and runtime drift |
| PR publication/handoff completion health | Local committed branches, pushed heads, validation/handoff/PR artifacts, recorded PR metadata, and failed PR creation are reconciled |

## Minimum Gate

Run:

```bash
./scripts/agent-check.sh
```

Also fill in `docs/quality/APP_LEGIBILITY.md` for the project and attach
`App-Proof:` or `Proof-Artifact:` lines to handoffs when runtime proof matters.
