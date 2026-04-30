---
name: implement-feature
description: Use when a ticket requests new behavior, a product capability, or an extension to an existing workflow. Clarify acceptance criteria, implement narrowly, and prove the result.
---

# Feature Implementation Workflow

1. Read the ticket, linked docs, and relevant code.
2. Restate acceptance criteria and out-of-scope work.
3. Identify the smallest implementation path that fits the architecture.
4. Update or add tests before or alongside the implementation.
5. Implement the feature without broad refactors.
6. Run targeted validation and `./scripts/agent-check.sh`.
7. Report what changed, why, tests run, risks, and follow-up issues.

