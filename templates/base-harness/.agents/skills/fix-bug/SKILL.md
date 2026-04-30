---
name: fix-bug
description: Use when a ticket describes broken behavior, failing tests, regressions, or production bugs. Reproduce first, then fix, then prove the fix.
---

# Bug-Fixing Workflow

1. Read the ticket and restate expected behavior, actual behavior, affected area,
   and acceptance criteria.
2. Audit whether the current code already contains the expected fix and whether
   the reported bug is stale.
3. If already fixed, make no code changes, run validation, and report
   `AgentOS-Outcome: already-satisfied`.
4. Reproduce the issue with an existing failing test, a new failing test, logs,
   or a clear manual reproduction.
5. Diagnose the smallest root cause.
6. Fix the issue with the narrowest coherent change.
7. Validate with targeted tests and `./scripts/agent-check.sh`.
8. Report root cause, fix summary, tests run, and remaining risks.
