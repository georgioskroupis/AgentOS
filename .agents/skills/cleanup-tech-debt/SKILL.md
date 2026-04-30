---
name: cleanup-tech-debt
description: Use when reducing maintenance burden without changing product behavior. Keep changes narrow and mechanically provable.
---

# Tech Debt Cleanup Workflow

1. Identify the maintenance problem and the current behavior to preserve.
2. Add or confirm tests before refactoring.
3. Make one coherent cleanup at a time.
4. Avoid unrelated style churn.
5. Run `./scripts/agent-check.sh` and report behavior-preservation evidence.
