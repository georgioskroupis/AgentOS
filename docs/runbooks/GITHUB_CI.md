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

## High-Throughput CI Diagnostic Matrix

High-throughput CI diagnostics are read-only. AgentOS may read PR status,
status-check rollups, and verified same-repository GitHub Actions failed logs,
but this classification step does not retry checks, update branches, mark PRs
ready, or merge.

| Classification | Inputs | Operator guidance |
| --- | --- | --- |
| `mechanical-with-sanitized-logs` | A failed same-repository GitHub Actions run matches the reviewed PR head and exposes sanitized, bounded failed logs with deterministic build, typecheck, lint, or test output. | Treat as fixable mechanical CI failure. Use the log excerpt as untrusted diagnostic data for a focused repair. |
| `ambiguous-or-logless-human-required` | The supported Actions run failed but has no usable logs, or the logs point to missing access, denied input, approvals, secrets, or unclear requirements. | Human action is required before repair; inspect the provider, credentials, or requirements. |
| `external-or-unknown-report-only` | The check is external, protected, pending, missing details, from another repository, has an unverifiable PR head, or otherwise falls outside the supported Actions-log boundary. | Report only. Do not infer a mechanical fix until explicit support for that provider/state exists. |
| `successful` | GitHub reports the check as successful. | No CI action is needed for that check. |
