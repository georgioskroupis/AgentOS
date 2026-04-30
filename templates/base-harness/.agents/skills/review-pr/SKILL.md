---
name: review-pr
description: Use when reviewing a pull request. Prioritize defects, regressions, missing tests, and risky behavior changes before style commentary.
---

# PR Review Workflow

1. Read the PR summary, linked issue, and changed files.
2. Identify behavior changes and affected contracts.
3. Look for bugs, missing validation, missing tests, security issues, and docs gaps.
4. Report findings with file and line references.
5. If no issues are found, say so and name remaining risk.
6. When AgentOS asks for a Wiggum artifact, write the required JSON file exactly
   at the requested path with blocking findings marked `P0`, `P1`, or `P2`.
