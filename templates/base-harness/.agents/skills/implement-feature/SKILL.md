---
name: implement-feature
description: Use when a ticket requests new behavior, a product capability, or an extension to an existing workflow. Clarify acceptance criteria, implement narrowly, and prove the result.
---

# Feature Implementation Workflow

1. Read the ticket, linked docs, and relevant code.
2. Restate acceptance criteria and out-of-scope work.
3. Audit whether the acceptance criteria are already satisfied by existing code,
   tests, commands, or docs.
4. If already satisfied, make no code changes, run validation, and report
   `AgentOS-Outcome: already-satisfied`.
5. If partially satisfied, preserve the existing path and implement only the
   missing delta.
6. Identify the smallest implementation path that fits the architecture.
7. Update or add tests before or alongside the implementation.
8. Implement the feature without broad refactors.
9. Run targeted validation and `./scripts/agent-check.sh`.
10. When writing an AgentOS handoff, include a `Validation-JSON:` pointer to
    machine-readable validation evidence with command names, exit codes, and
    timestamps.
11. Report what changed, why, tests run, risks, and follow-up issues.
