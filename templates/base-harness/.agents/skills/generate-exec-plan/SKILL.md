---
name: generate-exec-plan
description: Use when requirements are ambiguous or broad enough that an implementation plan should be created before editing code.
---

# Execution Plan Workflow

Use this skill to turn a large or ambiguous issue into an issue-driven execution
plan before implementation starts. Issues remain the unit of orchestration; PRs
are optional outputs of completed issues, not the planning unit.

1. Analyze the large issue by restating the goal, success criteria,
   authoritative scope, and out-of-scope work.
2. Inspect relevant docs, code, tests, validation evidence, issue state, and
   existing planning artifacts before proposing new work.
3. Produce a planner output with these fields:
   `goal`, `current_state`, `non_goals`, `execution_plan`, `child_issues`,
   `dependencies`, `validation_strategy`, `proof_artifacts`,
   `risks_or_decisions`, and `handoff_notes`.
4. Split the work into ordered, independently reviewable child issue proposals.
   Each child issue should include `title`, `goal`, `scope`, `out_of_scope`,
   `acceptance_criteria`, `relevant_files`, `blocked_by`, `unblocks`,
   `validation`, `proof`, and `handoff_expectations`.
5. Express blockers and dependencies as Linear-ready issue relationships so
   Symphony can execute the DAG naturally after the issues exist. Do not
   implement tracker-writing helpers or change dispatch behavior as part of the
   plan.
6. Write acceptance criteria per child issue in observable terms. Prefer
   criteria that can be proven by a focused check, runtime proof, or artifact
   instead of broad prose.
7. Define validation and proof per child issue. Reserve full-suite validation
   such as `npm run agent-check` for the handoff point or unchanged-head reuse
   boundary, and use narrower checks for intermediate child issues when they are
   sufficient.
8. Call out blockers, sequencing risks, and decisions that need human input.
