# Runbooks

Put repeatable operational procedures here.

Good runbooks include:

- prerequisites
- commands to run
- expected output
- rollback or failure behavior

## AgentOS Daemon Environment

If this repo is run by the AgentOS daemon, store restart-safe local environment
in `.agent-os/env` when needed:

```bash
LINEAR_API_KEY=lin_...
AGENT_OS_SOURCE_REPO=/path/to/agent-os
```

The daemon loads this file before resolving `WORKFLOW.md`, reports whether it is
missing, malformed, stale, or loaded, and refuses to dispatch when required
credentials are unavailable. High-throughput landing should also report GitHub
auth availability, daemon freshness, selected PR head, validation `repoHead`,
and GitHub check head; fix missing auth, restart stale daemons, rerun validation,
or wait for checks on the selected head before moving an issue back to
`Merging`.

## Human Review Re-Entry

When returning a Human Review issue to an active state, use a trusted Linear
comment from a stable Linear user ID or verified email that matches the issue
assignee or a configured `lifecycle.trusted_decision_actors` entry:

```text
AgentOS-Human-Decision: fix-findings
PR-Head-SHA: <sha>
Validation-JSON: .agent-os/validation/<issue>.json
CI-State: passed
Findings: open
Decision-Summary: address the reviewer findings on the existing PR
```

Allowed values are `fix-findings`, `approve-as-is`, `accept-risk`,
`split-follow-up`, and `proceed-to-merge-after-supervisor-fix`. Untrusted
comments, agent-authored handoff decisions, and local/manual records remain
visible to the next agent as context but do not pause, redispatch, or advance
the issue lifecycle.

If a human supervisor needs to move state or post that decision from a terminal,
use the by-identifier helpers instead of direct GraphQL by UUID:

```bash
bin/agent-os supervisor move <identifier> <state> --repo .
bin/agent-os supervisor decide <identifier> fix-findings \
  --validation .agent-os/validation/<identifier>.json \
  --pr-head-sha <sha> \
  --ci-state passed \
  --findings resolved \
  --summary "review findings are resolved" \
  --repo .
```

Agent turns must not use the supervisor bypass.
