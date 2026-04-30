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

Only the first roadmap issue should start in `Ready`; later issues stay out of
`Ready` until the previous item is complete.

