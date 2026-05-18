# GitHub CI Runbook

AgentOS includes `.github/workflows/ci.yml`. It runs:

```yaml
name: AgentOS CI

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  agent-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run agent-check
```

GitHub auth used to push workflow-file changes must include the `workflow`
scope. High-throughput landing verifies `gh auth status` before reading or
merging PRs and records only availability, never raw token values. If preflight
reports missing GitHub auth, run `gh auth status`, authenticate with
`gh auth login` or a valid `GH_TOKEN`/`GITHUB_TOKEN`, then restart or rerun
AgentOS.

The merge shepherd requires at least one successful GitHub check before it
squash-merges a PR. Landing freshness compares the selected PR head, validation
`repoHead`, and GitHub check head. Stale validation or check heads must be
repaired by rerunning validation and waiting for GitHub Actions on the selected
PR head before moving back to `Merging`.
