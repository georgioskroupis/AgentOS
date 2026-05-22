# Test Suite Map

Use this file to keep project tests layered and cheap to reason about.

## Layer Rules

| Layer | Use For |
| --- | --- |
| Unit | Pure parsing, scoring, policy, and formatting rules |
| Boundary | CLI helpers, shell scripts, adapters, and file-system contracts |
| Integration | Multi-boundary workflows that need realistic state or fake services |
| Full harness | `./scripts/agent-check.sh` and CI proof before handoff |

Prefer the narrowest layer that proves the behavior. Add integration coverage
only when the behavior depends on several boundaries working together.

## Validation Budget Classes

- Focused checks: run the smallest relevant test or smoke command while editing.
- Full local harness: run `./scripts/agent-check.sh` before handoff when
  dependencies are installed and the change affects source, workflow, tests, or
  public docs.
- Reused evidence: reuse previous full validation only when the code head and
  workflow/risk profile are unchanged and the project explicitly records that
  reuse in validation evidence.
- CI authority: when local full validation is unavailable or a long local run
  is inconclusive, record the local focused checks and rely on a green required
  CI gate before merge.

Long phases should emit progress. `scripts/agent-check.sh` prints phase
duration and periodic heartbeat lines controlled by
`AGENT_CHECK_HEARTBEAT_SECONDS` so slow-but-healthy validation is not confused
with a stalled agent.

## Audit Findings

Keep the project-specific findings here:

- Broad integration tests that must remain broad and why.
- Tests that were pruned or merged and the replacement proof.
- Slow-but-healthy tests that should be budgeted instead of made flaky by
  lowering timeouts.

## Inventory

| File | Layer | Contract Protected |
| --- | --- | --- |
| `tests/example.test.*` | Unit | Replace this row with the project's real tests |

## When To Prune

Prune or merge a test only when a narrower test already proves the same public
contract, the test preserves obsolete behavior, or it checks fixture text rather
than product or workflow behavior.
