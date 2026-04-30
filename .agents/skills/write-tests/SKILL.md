---
name: write-tests
description: Use when adding or strengthening automated coverage. Start from behavior and acceptance criteria, not implementation details.
---

# Test-Writing Workflow

1. Identify the behavior under test and failure mode.
2. Prefer the narrowest test that proves the behavior.
3. Add fixtures only when they clarify the scenario.
4. Run the targeted test first, then `./scripts/agent-check.sh`.
5. Report which behavior is now protected.
