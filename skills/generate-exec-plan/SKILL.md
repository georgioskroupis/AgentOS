---
name: generate-exec-plan
description: Use when requirements are ambiguous or broad enough that an implementation plan should be created before editing code.
---

# Execution Plan Workflow

1. Restate the goal, success criteria, and out-of-scope work.
2. Inspect relevant docs and code.
3. Split the work into ordered, independently reviewable tasks.
4. Specify validation for each task.
5. Express dependencies as Linear-ready blockers so Symphony can execute the DAG
   naturally.
6. Include clear acceptance criteria, relevant files, validation, and handoff
   expectations for each generated issue.
7. Call out blockers and decisions that need human input.
