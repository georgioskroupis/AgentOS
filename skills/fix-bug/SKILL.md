---
name: fix-bug
description: Use when a ticket describes broken behavior, failing tests, regressions, or production bugs. Reproduce first, then fix, then prove the fix.
---

# Bug-Fixing Workflow

1. Read the ticket and restate expected behavior, actual behavior, affected area,
   and acceptance criteria.
2. Reproduce the issue with an existing failing test, a new failing test, logs,
   or a clear manual reproduction.
3. Diagnose the smallest root cause.
4. Fix the issue with the narrowest coherent change.
5. Validate with targeted tests and `./scripts/agent-check.sh`.
6. Report root cause, fix summary, tests run, and remaining risks.

