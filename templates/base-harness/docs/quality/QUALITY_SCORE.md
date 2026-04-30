# Quality Score

Use this rubric to make quality expectations explicit.

| Area | Target |
| --- | --- |
| Tests | Relevant behavior is covered by automated tests |
| Types | Type checks pass where the project supports them |
| Lint | Lint and formatting checks pass |
| Architecture | Changes respect documented boundaries |
| Docs | Behavior and public interfaces stay documented |
| Security | Secrets, auth, and data handling are reviewed when touched |

## Minimum Gate

Run:

```bash
./scripts/agent-check.sh
```

