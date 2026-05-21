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

Marking a draft PR ready is also gated by landing freshness. AgentOS only calls
`gh pr ready` when high-throughput landing is enabled,
`github.mark_draft_ready: true` is configured, the trusted approval still
matches the PR head, and checks are fresh and green. This avoids using GitHub
draft state as a second control plane under conservative/public workflows.

## High-Throughput CI Diagnostic Matrix

High-throughput CI diagnostics may read PR status, status-check rollups, and
verified same-repository GitHub Actions failed logs. Only the flaky/retryable
classification can trigger an automatic check rerun, and that rerun is bounded
by `agent.max_retry_attempts`. The retry path calls `gh run rerun <run-id>
--failed`, records the attempt in durable issue state, and surfaces it in
`status`, `inspect`, and the Linear review comment. It does not update
branches, mark PRs ready, or merge.

| Classification | Inputs | Operator guidance |
| --- | --- | --- |
| `mechanical-with-sanitized-logs` | A failed same-repository GitHub Actions run matches the reviewed PR head and exposes sanitized, bounded failed logs with deterministic build, typecheck, lint, or test output. | Treat as fixable mechanical CI failure. Use the log excerpt as untrusted diagnostic data for a focused repair. |
| `flaky-retryable` | A failed same-repository GitHub Actions run matches the reviewed PR head and exposes sanitized, bounded failed logs for a supported transient network or runner-infrastructure condition. | AgentOS may request one bounded rerun of failed jobs while retry budget remains. If the budget is exhausted or the rerun request fails, escalate to human review. |
| `ambiguous-or-logless-human-required` | The supported Actions run failed but has no usable logs, or the logs point to missing access, denied input, approvals, secrets, or unclear requirements. | Human action is required before repair; inspect the provider, credentials, or requirements. |
| `external-or-unknown-report-only` | The check is external, protected, pending, missing details, from another repository, has an unverifiable PR head, points to branch protection or merge queue requirements, or otherwise falls outside the supported Actions-log boundary. | Report only. Do not infer a mechanical fix or flaky retry until explicit support for that provider/state exists. |
| `successful` | GitHub reports the check as successful. | No CI action is needed for that check. |

Flaky retries are deliberately narrower than CI repair. Deterministic build,
typecheck, lint, syntax, and assertion failures go to the focused fixer path
when policy and trust mode allow it. Ambiguous/logless failures, external
checks, protected branch requirements, and merge queue requirements stay
operator-visible but are not retried by AgentOS.

## Branch Freshness

When an issue is in the configured merge state and high-throughput landing is
explicitly enabled, AgentOS may update a stale PR branch only when GitHub reports
the PR as `BEHIND`, the PR is open and non-draft, and the head branch is an
AgentOS-managed same-repository `agent/*` branch. The bounded path runs one
`gh pr update-branch <pr>` call, refreshes the selected PR head plus GitHub
check evidence, records branch freshness state, and waits for fresh CI and
validation evidence before merge progression.

AgentOS reports instead of updating when the PR is cross-repository, the branch
is not an AgentOS-managed head branch, high-throughput landing is not enabled,
GitHub reports merge conflicts, or the PR is blocked by protected branch or
merge queue requirements. Branch freshness does not mark PRs ready, merge PRs,
or perform post-merge cleanup.
