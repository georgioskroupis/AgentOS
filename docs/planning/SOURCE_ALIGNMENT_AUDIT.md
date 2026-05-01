# Source Alignment Audit

This audit compares AgentOS against two OpenAI source articles:

- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [An open-source spec for Codex orchestration: Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/)

Treat these articles as architectural sources. They are not just inspiration.
At the same time, source alignment does not mean blind mimicry of OpenAI's
internal trust posture. Public-safe defaults may remain stricter when the
deviation is explicit, bounded, justified, and configurable.

## 1. Current Alignment Summary

AgentOS is source-aligned in its broad shape:

- Repository-local harness files, skills, scripts, and docs are the operating
  system for agents.
- `AGENTS.md` is short and points to deeper docs instead of becoming the system
  of record.
- `WORKFLOW.md` owns orchestration policy, prompt text, state names, trust mode,
  Codex command, review configuration, and GitHub merge mode.
- Linear is the single-project control plane.
- Issues are eligible work units and run in deterministic workspaces.
- Agents use standard repo-local tools such as `scripts/agent-create-pr.sh`,
  `gh`, validation scripts, and repository skills.
- Validation, review, PR creation, event policy, redaction, artifact hashes,
  simulation/replay, and `runs inspect` are executable feedback loops rather
  than prose-only expectations.

The main drift is not conceptual. The drift is ownership and strictness:

- AgentOS currently centralizes Linear lifecycle writes and merge shepherding in
  the orchestrator.
- AgentOS public defaults are deliberately safer than the high-trust OpenAI
  examples.
- Some repair and feedback loops still escalate earlier than Harness
  Engineering's agent-to-agent model would prefer.
- Multi-PR and no-PR issue paths are supported in state and tests, but some
  review and merge paths still behave as if there is one primary PR.

The correct target is configurable autonomy: keep safe public defaults, but make
source-faithful high-trust operation explicit and mechanically validated.

## 2. Harness Engineering Alignment

AgentOS aligns well with the Harness Engineering article on these points:

- Humans steer; agents execute. AgentOS encodes workflow, validation, review, and
  handoff expectations so the operator can steer through issues and prompts
  rather than manual editing.
- Missing capability is treated as the fix target. VER-33, VER-36, VER-34, and
  VER-39 each converted a failed dogfood path into a repo-local capability or
  guardrail instead of asking the agent to try harder.
- Repository knowledge is the system of record. The root map points to
  `README.md`, `ARCHITECTURE.md`, `WORKFLOW.md`, and `docs/`; planning notes,
  runbooks, release notes, quality score, trust model, and migration notes are
  versioned.
- `AGENTS.md` remains a map. The detailed behavior lives in docs, skills,
  workflow prompt text, and executable scripts.
- Capabilities are repo-local and legible. `scripts/agent-check.sh`,
  `scripts/agent-create-pr.sh`, skills, validation JSON, review JSON, and
  run artifacts are visible to agents.
- Standard development tools are preferred. Deterministic PR creation uses
  `gh pr create` through a harness script with prompts disabled instead of an
  interactive or MCP-only PR flow.
- Review and validation are executable loops. AgentOS verifies
  machine-readable validation evidence, runs reviewer turns, detects blocking
  findings, and can run fixer turns.
- Mechanical enforcement exists. `npm run agent-check` runs contract, docs,
  security, architecture, lint, format, tests, typecheck, and build checks.
- Agent legibility has improved. Durable run summaries, events, artifact hashes,
  validation evidence, session/token/rate-limit metrics, `inspect`, and
  `runs inspect` are available.

The remaining Harness gaps are real:

- Application legibility is not yet first-class for arbitrary target projects.
  Templates mention smoke tests and logs, but do not yet provide a complete
  checklist for app startup, runtime logs, metrics, traces, screenshots, videos,
  browser inspection, and CI artifact ingestion.
- Feedback loops are still more human-blocking than the OpenAI examples.
  Mechanical CI failures, review feedback, and PR updates should become more
  agent-to-agent where trust and automation policy permit.
- Public defaults currently prioritize avoiding surprise side effects over
  throughput. That is acceptable for a self-hosted/public toolkit, but it must
  remain documented and configurable.
- The quality/garbage-collection loop exists as maintenance seeding and quality
  docs, but recurring doc-gardening and quality-score refresh are not yet an
  always-on automation loop.

## 3. Symphony Alignment

AgentOS aligns with Symphony on the core scheduler shape:

- Linear is the control plane for the current single-project loop.
- `WORKFLOW.md` is repository-owned policy.
- Eligible issues in active states are fetched, filtered, and dispatched.
- Work runs in deterministic per-issue workspaces.
- Bounded concurrency, blocker checks, retry/backoff settings, terminal cleanup,
  run artifacts, and observability are implemented.
- Approval and user-input events are explicit and no longer stall runs
  indefinitely.
- Trust and sandbox posture are documented through `trust_mode` and strict
  workflow validation.
- Simulation/replay modes are local-only and non-networked.

AgentOS is not yet fully Symphony-faithful:

- Symphony treats the orchestrator primarily as scheduler, runner, and tracker
  reader. AgentOS currently gives the orchestrator first-class tracker write
  APIs and has it move states and write lifecycle comments.
- Symphony keeps ticket/PR/comment business logic in workflow prompts and agent
  tooling. AgentOS still has meaningful workflow business logic in
  `src/orchestrator.ts`, especially lifecycle comments, state transitions,
  review handoff, retry classification, and merge shepherding.
- Symphony's issue abstraction is broader than PRs. AgentOS supports no-PR and
  multi-PR state, but automated review and merge shepherding still mostly use a
  single primary PR.
- Symphony calls for authoritative orchestrator state for dispatch, retries, and
  reconciliation. AgentOS has durable run summaries and issue state, but Stage
  9A restart/retry reconstruction is still planning-only.
- Symphony expects every eligible active issue to have an agent running in an
  isolated workspace. AgentOS v0.1 RC1 is intentionally single-project and
  `max_concurrent_agents: 1` for dogfood; true registry-wide scheduling is a
  non-goal for this milestone.

## 4. Where AgentOS Is Stricter Than The OpenAI Examples

- `codex.approval_event_policy` and `codex.user_input_policy` default to
  `deny`. The OpenAI examples describe high-trust internal operation; AgentOS
  denies generic approval/input events unless a more permissive trust mode and
  policy explicitly allow them.
- Public templates default to `trust_mode: ci-locked`, no network, manual merge,
  and no human merge override.
- Full `agent-check` fails when dependency-backed checks cannot run; only
  `--structure-only` may skip them.
- Review turns have a narrow writable root for only the workspace-local review
  artifact destination and no network by default.
- Deterministic PR creation failure stops as `human_required` rather than
  trying interactive/MCP fallbacks.
- `workflow validate --strict` rejects unpinned Codex commands, incompatible
  trust/network/merge settings, and unsafe human merge overrides.

These strict defaults are defensible for a public/self-hosted orchestration
tool. They are not fully representative of OpenAI's high-throughput internal
workflow, so higher-autonomy behavior should be opt-in through separate config
axes:

- `trust_mode` for sandbox, network, and tool permissions.
- `lifecycle.mode` for tracker lifecycle ownership.
- `automation.profile` or `automation.repair_policy` for retry, repair, and
  feedback-loop behavior.

## 5. Where AgentOS Is More Orchestrator-Owned Than Symphony

Current orchestrator-owned behavior includes:

- Moving Linear issues to `In Progress`, `Human Review`, merge failure states,
  and `Done`.
- Posting run-started, handoff, failure, retry, review started, review approved,
  review needs human judgment, merge waiting, merge failed, and merge complete
  comments.
- Owning Linear lifecycle comment idempotency markers.
- Deciding when validation evidence is acceptable.
- Deciding when automated review starts, which reviewers run, when fixer turns
  run, and when `human_required` applies.
- Reading GitHub PR state, checks, review threads, and diff context.
- Shepherding merge-state issues through GitHub checks, squash merge, branch
  deletion, and final Linear state transition.

Some of this is coordination. Some is workflow policy.

Coordination that reasonably belongs in the orchestrator:

- Polling Linear.
- Dispatching eligible issues.
- Creating and locking workspaces.
- Starting, interrupting, and observing Codex turns.
- Persisting run state and artifacts.
- Enforcing sandbox/user-input policy.
- Reconciliation and retry scheduling.

Policy that should move toward `WORKFLOW.md`, tools, skills, or explicit
configuration:

- Who owns tracker comments and state transitions.
- Which lifecycle comments are substantive versus bookkeeping.
- Whether the agent or orchestrator records PR links.
- Whether merge shepherding is disabled, manual, or orchestrator-driven.
- Which mechanical failures trigger repair loops versus human handoff.

PR C should make lifecycle ownership explicit. `orchestrator-owned` can remain
the current safe mode. `agent-owned` should be experimental and must fail strict
validation unless tracker tools, idempotency markers, allowed transitions, and
fallback behavior are configured. `hybrid` can split safety bookkeeping from
substantive workflow comments.

## 6. Where AgentOS Is More PR-Centric Than Symphony

AgentOS has already corrected the most obvious PR-centric drift:

- Already-satisfied and no-op issues can end without a PR.
- Handoff parsing supports `prs[]` with zero, one, or many PRs.
- Validation and issue outcomes do not require PR metadata.

Remaining PR-centric pressure:

- Automated review is framed as happening after a run opens or updates a PR.
- Review prompts and GitHub context currently use a primary PR URL.
- Merge shepherding is built around one primary PR per issue.
- Runbooks and skills still emphasize PR creation heavily because recent
  dogfood blockers were PR-path failures.
- Investigation-only, planning-only, and follow-up-issue workflows are not as
  prominent as implementation-with-PR workflows.

PR E should remove unconditional PR creation wording and make these first-class:

- Already-satisfied no-op issue.
- Investigation-only issue.
- Planning-only issue.
- Docs/code issue with one PR.
- Larger issue with multiple PRs.
- Issue that generates follow-up issues.

Deterministic PR creation should stay. It is the correct harness capability
when a PR is needed.

## 7. Where AgentOS Is Less Agent-Autonomous Than Harness Engineering

AgentOS is less autonomous than the OpenAI Harness Engineering examples in
these areas:

- Agents are told not to move or comment on Linear. Symphony says tracker writes
  are typically agent-owned through workflow/runtime tools.
- Generic elicitation/user-input is denied even in the dogfood workflow. This is
  safe, but it means some valid high-trust workflows require new deterministic
  tools instead of inline approval.
- PR feedback handling is present but not yet a mature agent-to-agent loop.
  AgentOS can summarize feedback and run fixer turns, but the behavior is not
  yet a broad "respond to human and agent feedback until satisfied" capability.
- CI repair is documented through skills, but the orchestrator does not yet
  prefer bounded mechanical repair loops when CI logs are available.
- Merge automation exists only behind the `Merging` state and `github.merge_mode`
  gates. The OpenAI examples describe agents often driving PRs closer to merge
  in high-trust settings.
- Some missing capability failures escalate immediately to humans instead of
  opening a small capability-building issue.

PR D should define high-trust automation as an automation/repair behavior
profile, not as a `trust_mode`. PR F should implement or tighten bounded repair
and feedback behavior separately.

## 8. Where AgentOS Is Missing Agent-Legibility Capabilities

AgentOS has good orchestration legibility and weaker application legibility.

Current strengths:

- JSONL run events.
- Per-run summaries with `schemaVersion`.
- Prompt, event, handoff, validation, and review artifacts.
- Artifact hashes and `runs inspect` mismatch warnings.
- Session, token, rate-limit, started, and finished metadata.
- Redaction before persistence.
- `status`, `inspect`, `runs list`, `runs inspect`, `runs simulate`, and
  `runs replay`.

Missing or thin:

- Target-project startup command registry.
- Standard log capture and querying contract for target projects.
- Metrics/traces contract for API and service projects.
- Screenshot or video proof guidance for UI projects.
- Browser inspection checklist where applicable.
- CI log artifact ingestion into run artifacts.
- Runtime failure summaries that explain why a run stopped in one machine-
  readable object.
- Recurring doc-gardening and quality-score refresh loops.
- Template-level checklist for what every project should expose so agents can
  inspect app behavior without human narration.

PR G should add the project harness legibility checklist and lightweight
template guidance. It should not overbuild a generic observability platform.

## 9. Which Deviations Are Intentional Public-Safety Defaults

These deviations are intentional and should remain available:

- Public templates default to `trust_mode: ci-locked`.
- Public templates default to `github.merge_mode: manual`.
- Approval and user-input event policies deny by default.
- Deterministic PR creation uses non-interactive `gh`; MCP PR creation is not
  used for handoff because it can elicit.
- Review turns may write only the review artifact path and have no network by
  default.
- Full validation is required by default and fails if dependencies are missing.
- Runtime `.agent-os/` remains ignored and uncommitted.
- Simulation/replay must never instantiate real Linear, GitHub, or Codex
  clients.

These are stricter than the OpenAI internal examples, but they are bounded by
configuration and justified by public/self-hosted safety.

## 10. Which Deviations Are Configurable

Already configurable:

- `trust_mode`: `review-only`, `ci-locked`, `local-trusted`, `danger`.
- Codex command, approval event policy, user-input policy, sandbox policy, turn
  timeout, read timeout, and stall timeout.
- Tracker active, terminal, running, review, merge, and needs-input states.
- Workspace root and lifecycle hooks.
- Agent concurrency, max turns, retry attempts, retry backoff, and per-state
  concurrency.
- Review enabled flag, reviewers, max iterations, blocking severities, and
  convergence requirements.
- GitHub merge mode, merge method, check requirement, branch deletion, done
  state, and human merge override.
- Strict versus structure-only validation.

Should become configurable:

- Lifecycle ownership: `orchestrator-owned`, `hybrid`, and experimental
  `agent-owned`.
- Automation/repair policy: conservative, local-trusted repair, and
  high-throughput bounded repair loops. This must be separate from `trust_mode`.
- PR review target selection when an issue has multiple PRs.
- Handoff behavior for investigation-only and planning-only issues.
- What counts as mechanical failure versus judgment-heavy failure.

## 11. Which Deviations Need Refactor

Refactor-needed deviations:

- Lifecycle ownership is implicit and orchestrator-owned. It needs an explicit
  config axis and validation.
- Agent-owned lifecycle mode does not exist. It should be experimental and
  strict-validation-gated on tracker tools, idempotency contracts, allowed
  transitions, and fallback behavior.
- High-throughput behavior is not modeled. It should be an automation/repair
  profile, not a trust label.
- Review and feedback loops should escalate less often for mechanical failures
  when policy allows bounded repair.
- PR-centric wording should be reduced so no-PR and multi-PR issue paths are as
  legible as one-PR paths.
- Multi-PR review and merge behavior still relies on a primary PR in several
  code paths.
- Stage 9A durable retry/startup reconstruction remains necessary before true
  multi-project daemon scheduling.
- Agent legibility for target applications needs a template-level checklist.

## 12. Current Source-Faithfulness Score

Harness Engineering alignment: B+

- Strong on repository-local harnessing, short `AGENTS.md`, standard tools,
  executable validation, validation artifacts, review loop, and run
  observability.
- Weaker on high-throughput feedback handling, application-legibility
  templates, recurring cleanup, and agent-to-agent completion of PR feedback.

Symphony alignment: B-

- Strong on issue tracker control plane, per-issue workspaces, `WORKFLOW.md`,
  bounded dispatch, Codex App Server, explicit trust posture, and observability.
- Weaker on scheduler/runner/tracker-reader boundary, agent-owned tracker
  writes, full restart recovery, primary-PR assumptions, and registry-wide
  daemon scheduling.

Top three intentional deviations:

1. Deny approval/user-input events by default instead of high-trust inline
   approval.
2. Keep public `github.merge_mode: manual` while AgentOS dogfood can opt into
   `shepherd`.
3. Keep review sandboxes narrow and networkless by default.

Top three refactor-needed deviations:

1. Make Linear lifecycle ownership explicit and configurable without losing
   idempotency or safety.
2. Separate automation/repair behavior from trust mode and add bounded
   high-throughput repair semantics.
3. Recenter prompts/docs/review/merge paths on issues, with no-PR and multi-PR
   paths treated as first-class.

## 13. Recommended Next PRs C-G

PR C: Reduce orchestrator-owned workflow business logic where safe.

- Add `lifecycle.mode` or equivalent.
- Preserve `orchestrator-owned` as the stable safe mode.
- Add `hybrid` where practical.
- Treat `agent-owned` as experimental and make strict validation fail unless
  tracker tools, idempotency markers, allowed transitions, and fallback behavior
  are configured.
- Keep lifecycle ownership separate from `trust_mode` and automation policy.

PR D: Add high-trust automation profile without weakening public defaults.

- Do not add `high-throughput` as a `trust_mode`.
- Keep `trust_mode` for sandbox, network, and tool permissions only.
- Add `automation.profile` or `automation.repair_policy` for repair-loop
  behavior.
- Define high-throughput as bounded repair/feedback behavior that prefers cheap
  mechanical correction when policy allows it.

PR E: Recenter the system on issues, not PRs.

- Remove unconditional PR creation wording from workflow docs, templates, and
  skills.
- Make no-op, investigation-only, planning-only, one-PR, multi-PR, and
  follow-up-issue paths explicit.
- Ensure `WORKFLOW.md` never implies every issue must create a PR.
- Keep deterministic PR creation as the recommended path when a PR is needed.

PR F: Make review and feedback loops more agent-to-agent, less human-blocking.

- Keep separate from PR D: PR D defines profiles and capabilities; PR F changes
  bounded loop behavior.
- Preserve `review.max_iterations` and repeated-finding detection.
- Prefer fixer/CI-diagnostics loops for mechanical issues where trust and
  automation policy permit.
- Escalate for ambiguous requirements, safety/security judgment, repeated
  failure, missing capability, or denied approval/user-input.

PR G: Improve agent legibility checklist for future projects.

- Add template/runbook guidance for startup, logs, smoke tests, metrics, traces,
  screenshots/video, browser inspection, CI logs, validation artifacts, quality
  score, doc-gardening, and cleanup.
- Add maintenance issue templates where useful.
- Keep checks lightweight unless a mechanical invariant is obvious.

After PRs C-G, add a planning-only Stage 9A readiness decision before any
implementation. Stage 9A durable retry/startup reconstruction should still come
before true multi-project daemon scheduling.

## 14. Dogfood Evidence

Current dogfood evidence supports moving from PR A to this audit PR:

- VER-40 created branch `agent/VER-40`.
- Commit `b78b990` was produced.
- Draft PR #22 was opened through deterministic PR creation.
- No MCP elicitation occurred.
- Validation evidence was accepted.
- Review artifacts were written from the review sandbox and approved.
- Linear moved to `Human Review`.
- Run `run_20260501155028_VER-40_c3e8cf` finished `succeeded`.
- `runs inspect` reported no warnings.
- Workspace locks were released.
- Runtime `.agent-os/` stayed ignored and uncommitted.

This evidence proves the immediate VER-39 blocker is cleared. It does not prove
that broad dogfood should resume or that PR C-G behavior is safe to implement
without the staged reviews above.
