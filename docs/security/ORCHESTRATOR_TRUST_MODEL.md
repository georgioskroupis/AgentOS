# Orchestrator Trust Model

AgentOS workflow files declare a top-level `trust_mode`. The mode describes
what the orchestrator and Codex App Server turns are allowed to assume about
network, repository writes, PR access, and user input.

Lifecycle ownership is a separate axis under `lifecycle.mode`. Do not use
`trust_mode` to encode who owns tracker comments or Linear state transitions.
That belongs to lifecycle ownership. Repair-loop behavior is a third axis under
`automation`, not a `trust_mode`.

## Capability Matrix

| Mode | Network | Repo writes | Review writes | PR/network access | GitHub merge | Codex user input |
| --- | --- | --- | --- | --- | --- | --- |
| `review-only` | off | off | on | off | off | deny |
| `ci-locked` | off | workspace | on | off | off | deny |
| `local-trusted` | on | workspace | on | on | on | deny |
| `danger` | on | broad | on | on | on | allow |

Public templates default to `ci-locked`. AgentOS dogfood uses `danger` because
the live roadmap daemon is intentionally responsible for local orchestration,
GitHub/Linear operations, repo-local runtime cleanup, worktree recovery, and
other full-project maintenance without supervisor intervention.

## Compatibility Checks

`agent-os workflow validate --strict` fails when configuration asks for a
capability the selected trust mode does not allow:

- `codex.turn_sandbox_policy.networkAccess: true` requires a network-capable
  trust mode.
- `github.merge_mode: shepherd` or `auto` requires PR/network and GitHub merge
  capability.
- `trust_mode: review-only` cannot run repository-writing implementation
  turns.
- `codex.approval_event_policy: allow` requires `trust_mode: danger`.
- `codex.user_input_policy: allow` requires a mode with Codex user-input
  capability.

`github.merge_mode: manual` is the public default. In that mode AgentOS can
prepare review handoffs, but it will not shepherd or merge PRs automatically.

## Defaults

AgentOS pins the Codex App Server command by default:

```yaml
codex:
  command: npx -y @openai/codex@0.125.0 app-server
  approval_event_policy: deny
  user_input_policy: deny
```

The default `ci-locked` turn sandbox uses workspace write access with network
disabled. For Git worktree-based agent workspaces, AgentOS also grants the
active worktree's Git metadata directories as writable roots so ordinary Git
commands can update the index, `FETCH_HEAD`, and repository object metadata
without requiring broad filesystem access. Projects that need dependency
installation, browser access, or GitHub PR operations should explicitly opt into
`local-trusted` and explain that choice in the PR.

The AgentOS dogfood workflow goes further and opts into `danger` with
`dangerFullAccess` turns. That posture is not a public-template default; it is
the autonomy posture for this repository's own roadmap runner.

Automated review turns are narrower than implementation turns: AgentOS gives
reviewers a workspace-local `.agent-os/reviews/...` artifact destination, no
network by default, and only that review artifact directory as a writable root.
The orchestrator validates the JSON before copying it into the canonical runtime
review store.

If the Codex App Server emits an approval or user-input request while those
policies are `deny`, AgentOS records a `codex_event_policy_denied` event and
fails the run instead of waiting for interactive input.

## Lifecycle Ownership

| Mode | Orchestrator state moves | Orchestrator comments | Notes |
| --- | --- | --- | --- |
| `orchestrator-owned` | on | bookkeeping and substantive handoff | Current safe default and intentional AgentOS deviation from Symphony's usual tracker-write boundary. |
| `hybrid` | on | bookkeeping only | Agent artifacts/tools own substantive handoff/update content and PR metadata. |
| `agent-owned` | off | off | Experimental. Strict validation requires tracker tools, idempotency marker format, allowed transitions, duplicate-comment behavior, fallback behavior, and an acknowledgement that durable retry/startup reconstruction is not yet complete. |

## Automation And Repair Behavior

Automation policy is not a permission model. It describes how AgentOS should
prefer feedback and repair loops after trust and lifecycle checks have already
allowed the required tools.

| Setting | Meaning |
| --- | --- |
| `automation.profile: conservative` | Public-safe default. Prefer explicit handoff over extra repair loops. |
| `automation.profile: high-throughput` | Opt-in internal/dogfood posture aligned with Harness Engineering's cheap-correction loop. Prefer deterministic tools, CI/log reading, review-feedback handling, and bounded mechanical repair where configured. |
| `automation.repair_policy: conservative` | Do not add additional repair-loop behavior beyond existing review/fixer handling. |
| `automation.repair_policy: mechanical-first` | Prefer bounded mechanical repair before human escalation when the issue is tool-addressable and the trust mode permits the required tools. |

`high-throughput` does not grant network, GitHub, Linear, merge, approval, or
user-input capability. Generic MCP elicitation remains denied unless the
separate Codex event policy and trust mode explicitly allow it.

Runtime repair loops stay bounded by `review.max_iterations`. Reviewer findings
can trigger focused fixer turns on the existing PR. CI repair is narrower:
AgentOS reads PR/check status and failed GitHub Actions logs, and
`automation.repair_policy: mechanical-first` only permits a fixer when the logs
classify the failure as mechanical. Missing logs, ambiguous requirements, denied
approval/user-input, and repeated findings escalate to `Human Review`.
