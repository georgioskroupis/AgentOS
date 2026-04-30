---
name: ci-diagnostics
description: Use when GitHub checks fail, are missing, or are pending too long. Read CI state with gh, isolate the failure, fix narrowly, and rerun validation.
---

# CI Diagnostics Workflow

1. Use `gh pr view`, `gh run list`, `gh run view`, or check URLs to identify the
   failing workflow, job, and log section.
2. Distinguish product/test failures from infrastructure flakes.
3. Reproduce locally with the narrowest relevant command when possible.
4. Fix the root cause without weakening checks.
5. Run `./scripts/agent-check.sh` or the repo equivalent.
6. Update the handoff with CI status, local validation, remaining risk, and
   follow-up issues for flakes outside scope.
