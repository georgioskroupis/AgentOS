# Orchestrator Trust Model

AgentOS workflow files declare a top-level `trust_mode`. The mode describes
what the orchestrator and Codex App Server turns are allowed to assume about
network, repository writes, PR access, and user input.

## Capability Matrix

| Mode | Network | Repo writes | Review writes | PR/network access | GitHub merge | Codex user input |
| --- | --- | --- | --- | --- | --- | --- |
| `review-only` | off | off | on | off | off | deny |
| `ci-locked` | off | workspace | on | off | off | deny |
| `local-trusted` | on | workspace | on | on | on | deny |
| `danger` | on | broad | on | on | on | allow |

Public templates default to `ci-locked`. AgentOS dogfood uses
`local-trusted` because it intentionally runs local orchestration with GitHub
and Linear access.

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
disabled. Projects that need dependency installation, browser access, or GitHub
PR operations should explicitly opt into `local-trusted` and explain that choice
in the PR.

Automated review turns are narrower than implementation turns: AgentOS gives
reviewers a workspace-local `.agent-os/reviews/...` artifact destination, no
network by default, and only that review artifact directory as a writable root.
The orchestrator validates the JSON before copying it into the canonical runtime
review store.

If the Codex App Server emits an approval or user-input request while those
policies are `deny`, AgentOS records a `codex_event_policy_denied` event and
fails the run instead of waiting for interactive input.
