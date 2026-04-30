# Linear Setup Runbook

## Company Workspace Login

1. Connect or switch the Linear integration to the company workspace.
2. Set `LINEAR_API_KEY` for local CLI use if using API-key mode.
3. Run:

```bash
bin/agent-os linear teams
```

4. Seed the roadmap into the primary solo-founder team:

```bash
bin/agent-os linear seed-roadmap --team <team-key-or-id> --project AgentOS
```

Only the first roadmap issue should start in the active state; later issues stay
out of that state until the previous item is complete.

## Live AgentOS Project

- Workspace/team: `VerityStudio` (`VER`)
- Project: `AgentOS`
- URL: https://linear.app/veritystudio/project/agentos-08cea1e6f2f8
- Active state in this workspace: `Todo`
- Seeded roadmap: `VER-5` through `VER-21`

This workspace does not currently have a `Ready` state. `WORKFLOW.md` therefore
uses `Todo` as the active polling state for live orchestration.
