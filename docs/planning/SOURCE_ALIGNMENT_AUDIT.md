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
  lifecycle ownership, Codex command, review configuration, and GitHub merge
  mode.
- Linear is the single-project control plane.
- Issues are eligible work units and run in deterministic workspaces.
- Agents use standard repo-local tools such as `scripts/agent-create-pr.sh`,
  `gh`, validation scripts, and repository skills.
- Validation, review, PR creation, event policy, redaction, artifact hashes,
  simulation/replay, and `runs inspect` are executable feedback loops rather
  than prose-only expectations.

The main drift is not conceptual. The drift is ownership and strictness:

- AgentOS defaults Linear lifecycle writes and merge shepherding to the
  orchestrator, but lifecycle ownership is now an explicit config axis.
- AgentOS public defaults are deliberately safer than the high-trust OpenAI
  examples.
- Some repair and feedback loops still escalate earlier than Harness
  Engineering's agent-to-agent model would prefer.
- Multi-PR and no-PR issue paths are now first-class in workflow wording,
  handoff parsing, and state tests, but automated review and merge shepherding
  still operate on one primary PR for compatibility.

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
- Mechanical invariants now include `check:architecture` and `check:docs`
  coverage for layer boundaries, duplicate workflow concepts, duplicate state
  names, PR-centric wording regression, hidden lifecycle policy, file-size
  budgets, docs index coverage, cross-links, CLI command references, and this
  source-alignment audit staying current.
- Agent legibility has improved. Durable run summaries, events, artifact hashes,
  validation evidence, session/token/rate-limit metrics, `inspect`, and
  `runs inspect` are available.
- Existing Implementation Audit is now explicit prompt/runtime context for
  every implementation turn. Agents must compare acceptance criteria against
  existing source, docs, tests, issue state, workspaces, and PR metadata before
  editing and continue from partial artifacts instead of duplicating work.
- Targeted context packs now apply progressive disclosure to implementation
  re-entry, automated review, fixer, and mechanical CI repair turns. Packs keep
  authoritative decisions, selected PR metadata, bounded diffs, current
  findings, validation summaries, sanitized log excerpts, and artifact
  references while excluding stale transcripts and unrelated historic output.

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
- The quality/garbage-collection loop now has reusable maintenance templates,
  quality docs, and a deterministic `agent-os maintenance seed` helper, but it
  is not yet an always-on automation loop.

## 3. Symphony Alignment

AgentOS aligns with Symphony on the core scheduler shape:

- Linear is the control plane for single-project and registry orchestration.
- `WORKFLOW.md` is repository-owned policy.
- Eligible issues in active states are fetched, filtered, and dispatched.
- Work runs in deterministic per-issue workspaces.
- Bounded concurrency, blocker checks, retry/backoff settings, terminal cleanup,
  run artifacts, and observability are implemented.
- A pre-dispatch reconciliation guard refuses fresh implementation when current
  local, Linear, or GitHub truth shows already-completed work, approved work
  waiting on merge readiness, an already-merged selected PR, or recoverable
  partial work in an existing workspace.
- Approval and user-input events are explicit and no longer stall runs
  indefinitely.
- Trust and sandbox posture are documented through `trust_mode` and strict
  workflow validation.
- Simulation/replay modes are local-only and non-networked.

AgentOS still has these Symphony-faithfulness deviations:

- Symphony treats the orchestrator primarily as scheduler, runner, and tracker
  reader. AgentOS currently gives the orchestrator first-class tracker write
  APIs and has it move states and write lifecycle comments.
- Symphony keeps ticket/PR/comment business logic in workflow prompts and agent
  tooling. AgentOS still has meaningful workflow business logic in
  `src/orchestrator.ts`, especially lifecycle comments, state transitions,
  review handoff, retry classification, and merge shepherding.
- Symphony's issue abstraction is broader than PRs. AgentOS supports no-PR,
  investigation-only, one-PR, and multi-PR handoffs with explicit PR roles, but
  multi-PR paths remain less heavily dogfooded than the one-PR path.
- Symphony calls for authoritative orchestrator state for dispatch, retries, and
  reconciliation. AgentOS now has durable run summaries, issue state, and a
  schema-versioned runtime state file for startup retry reconstruction.
- Symphony expects every eligible active issue to have an agent running in an
  isolated workspace. AgentOS now has registry-wide scheduling with global and
  per-project caps; large-scope decomposition and unattended runtime stability
  still need post-MVP hardening.

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

PR C makes lifecycle ownership explicit. `orchestrator-owned` remains the
current safe mode. `agent-owned` is experimental and must fail strict validation
unless tracker tools, idempotency markers, allowed transitions, duplicate-comment
behavior, fallback behavior, and the durable-recovery maturity acknowledgement
are configured. `hybrid` splits safety bookkeeping from substantive workflow
comments.

VER-71 adds a dogfood fixture for the intended hybrid boundary: a worker can
post substantive ticket updates and handoff content through repo-local Linear
lifecycle tools, while scheduler-owned moves to running and review states remain
authoritative. Structured decisions in that path retain actor, source, and
authority metadata; unapproved authors are preserved as context-only evidence
and do not drive lifecycle continuation.

VER-95 adds the first client-side tracker tool for the experimental
`agent-owned` boundary. The Codex App Server runner advertises `linear_graphql`
only when the workflow opts into `agent-owned`, the tracker adapter is Linear,
and Linear credentials are configured. That closes the basic Symphony-aligned
tool-extension gap without changing the safe default: `orchestrator-owned`
continues to hide direct tracker tools, unsupported tool calls receive a
structured failure, and durable recovery of fully agent-owned tracker writes
remains experimental until later validation proves the boundary end to end.

VER-96 and VER-106 add a local observability surface for the scheduler/runner
boundary. The optional loopback HTTP API exposes durable runtime, issue, run,
retry, token, and rate-limit summaries plus a coalesced refresh hook; the
dashboard consumes that API directly instead of scraping files or starting a
parallel daemon. This follows Symphony's separation between orchestration state
and operator visibility while keeping Linear as the steering control plane.

## 6. Where AgentOS Is More PR-Centric Than Symphony

AgentOS has corrected the most obvious PR-centric drift:

- Already-satisfied and no-op issues can end without a PR.
- Handoff parsing supports `prs[]` with zero, one, or many PRs.
- Validation and issue outcomes do not require PR metadata.
- `WORKFLOW.md`, templates, skills, and runbooks describe issue outcomes before
  PR creation.
- Compatibility paths derive their primary PR from `prs[]` first and fall back
  to legacy `prUrl`.

Remaining PR-centric pressure:

- Automated review is explicitly scoped to PR-producing runs and now selects
  configured merge-eligible PR roles.
- Review prompts and GitHub context are explicit about selected PR targets.
- Merge shepherding is selected-target based and avoids review-only or
  do-not-merge PR roles.
- Runbooks and skills still emphasize PR creation heavily because recent
  dogfood blockers were PR-path failures.
- Investigation-only, planning-only, and follow-up-issue workflows are
  documented and covered by MVP certification evidence, but less frequent paths
  should continue to receive dogfood examples.

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
- PR feedback handling is now a bounded agent-to-agent loop for configured
  PR-producing work: review artifacts are retried narrowly, blocking mechanical
  findings can trigger fixer turns, repeated or ambiguous findings still
  escalate, and review budget policy recommends split/follow-up work when scope
  is too broad.
- CI repair and retry are opt-in high-throughput behavior: deterministic
  same-repository Actions logs can drive focused CI fixer turns, supported flaky
  failures can request bounded reruns, and ambiguous, logless, protected-branch,
  merge-queue, or external checks remain report-only/human-required.
- Merge automation exists only behind explicit landing gates, the configured
  `Merging` state, and `github.merge_mode` gates. The dogfood workflow now also
  supports draft PR readiness, branch freshness, selected-target merge, and
  idempotent post-merge cleanup in that high-trust path.
- Some missing capability failures escalate immediately to humans instead of
  opening a small capability-building issue.

High-throughput automation is now separate from `trust_mode` through lifecycle,
landing, and repair policy gates. The remaining work is cost/runtime tuning and
additional unattended dogfood evidence.

## 8. Where AgentOS Is Missing Agent-Legibility Capabilities

AgentOS has strong orchestration legibility and template-level application
legibility. Project-specific app proof depth remains opt-in.

Current strengths:

- JSONL run events.
- Per-run summaries with `schemaVersion`.
- Prompt, event, handoff, validation, and review artifacts.
- Artifact hashes and `runs inspect` mismatch warnings.
- Session, token, rate-limit, started, and finished metadata.
- Redaction before persistence.
- `status`, `inspect`, `runs list`, `runs inspect`, `runs simulate`, and
  `runs replay`.

Missing or intentionally lightweight:

- Deep, project-specific startup command registry beyond the lightweight
  `docs/quality/APP_LEGIBILITY.md` checklist.
- Rich log, metrics, and trace querying contracts for target projects.
- Required screenshot/video/browser proof for non-UI projects.
- Provider-specific CI log ingestion into every run artifact.
- Runtime failure summaries that explain why a run stopped in one machine-
  readable object.
- Runtime health now reports daemon liveness, stale PID files, empty-log failed
  launches, stopped daemons, credential preflight, and a persistent local launch
  command. `status`/`inspect` report recoverable partial work, stale PR or CI
  heads, unpushed commits, and a next safe action.
- Always-on scheduling for doc-gardening and quality-score refresh loops.

The MVP deliberately stops at portable proof hooks and docs rather than
requiring every target project to run a generic observability platform.

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
- Lifecycle ownership: `orchestrator-owned`, `hybrid`, and experimental
  `agent-owned`.
- Review enabled flag, reviewers, max iterations, blocking severities, and
  convergence requirements.
- GitHub merge mode, merge method, check requirement, branch deletion, done
  state, and human merge override.
- Automation/repair policy: `automation.profile` and
  `automation.repair_policy` model conservative and high-throughput behavior as
  a separate axis from `trust_mode`.
- Strict versus structure-only validation.

Should become configurable:

- PR review target selection when an issue has multiple PRs.
- Handoff behavior for investigation-only and planning-only issues.
- What counts as mechanical failure versus judgment-heavy failure.

## 11. Which Deviations Need Refactor

Refactor-needed deviations:

- Lifecycle ownership is explicit, but `hybrid` and `agent-owned` still need
  more dogfood before they should be considered mature.
- Agent-owned lifecycle mode remains an experimental strict-validation-gated
  path. Repo-local tracker tools exist, but broader dogfood evidence is still
  needed before it should replace the orchestrator-owned default.
- High-throughput behavior is modeled as automation policy and now includes
  bounded CI repair/retry, draft PR readiness, branch freshness, merge
  shepherding, and post-merge cleanup for trusted dogfood workflows. Protected
  branch and merge queue automation remain report-only future work.
- Review and feedback loops still need more dogfood evidence and cost/runtime
  tuning, but mechanical failures now have bounded repair paths when trust and
  automation policy allow them.
- No-PR, investigation-only, one-PR, and multi-PR paths now have certification
  evidence. Multi-PR review/merge handling is explicit, but should continue to
  receive dogfood coverage because it is less common than one-PR work.
- Stage 9A durable retry/startup reconstruction and registry-wide scheduling
  have MVP coverage; the remaining work is operational hardening and optional
  dashboard/API surfaces.
- Agent legibility for target applications now has checklist and proof scripts;
  project-specific depth should remain opt-in so lightweight repositories do not
  inherit heavyweight observability requirements.

## 12. Current Source-Faithfulness Score

Harness Engineering alignment: A-

- Strong on repository-local harnessing, short `AGENTS.md`, standard tools,
  executable validation, validation artifacts, review/fix loops, CI diagnostics,
  high-throughput landing, recurring cleanup templates, and run observability.
- Weaker on application-legibility proof for arbitrary target projects and
  cost/runtime optimization of broad validation.

Symphony alignment: A-

- Strong on issue tracker control plane, per-issue workspaces, `WORKFLOW.md`,
  bounded dispatch, Codex App Server, explicit trust posture, durable startup
  recovery, registry-wide scheduling, observability, and optional-PR issue
  outcomes with explicit PR roles.
- Weaker on mature agent-owned tracker writes, non-Linear tracker adapters,
  optional HTTP dashboard/API, and long-running unattended dogfood stability at
  larger issue sizes.

Top three intentional deviations:

1. Deny approval/user-input events by default instead of high-trust inline
   approval.
2. Keep public `github.merge_mode: manual` while AgentOS dogfood can opt into
   `shepherd`.
3. Keep review sandboxes narrow and networkless by default.

Top three refactor-needed deviations:

1. Continue dogfooding explicit Linear lifecycle ownership, especially
   `hybrid`, without losing idempotency or safety.
2. Mature agent-owned tracker writes and Human Review drift guards without
   weakening idempotent orchestrator safety.
3. Reduce validation/runtime cost and add optional dashboard/API surfaces
   without weakening the existing mechanical guardrails.

## 13. Current Dogfood Evidence

Current evidence is no longer a single PR-stack checkpoint. The AgentOS Linear
roadmap has dogfooded no-PR outcomes, implementation PRs, review/fixer loops,
CI diagnostics, flaky retry, draft readiness, branch freshness, merge
shepherding, post-merge cleanup, durable startup reconstruction,
registry-wide scheduling, and maintenance templates across VER-42 through the
VER-54 child issues.

High-throughput landing closeout evidence is recorded in
`docs/releases/high-throughput-landing-certification.json`. That artifact maps
VER-83 through VER-87 to concrete tests for enabled landing gates,
mechanical/flaky/ambiguous CI outcomes, trusted decision evidence refresh,
draft PR readiness, selected-target merge, cleanup warnings, conservative
public defaults, and protected-branch/merge-queue report-only behavior.

Final MVP certification is recorded in `docs/releases/MVP.md`. That artifact
maps the 12 required MVP scenarios to concrete tests, release artifacts, and
proof-script coverage, and records the intentional remaining deviations and
non-MVP future work.

Post-MVP evidence should focus on unattended stability, validation/runtime cost,
model-routing cost telemetry, optional dashboard/API surfaces, and broader
tracker adapters rather than re-proving the completed MVP capability stack.
