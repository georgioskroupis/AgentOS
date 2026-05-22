# Tracker Adapters

AgentOS uses `tracker.kind` to select a registered issue tracker adapter.
`linear` is the built-in production adapter. Additional adapters should preserve
the Symphony issue-domain contract while changing only transport details.

## Contract

Adapters must implement:

- `fetchCandidates(activeStates)` for candidate issues in configured active
  states.
- `fetchIssueStates(issueIds)` for id-to-issue/null lookup.

Optional methods are enabled only when the workflow path needs them:

- `fetchTerminalIssues(terminalStates)`
- `fetchIssueComments(issueIdentifierOrId, limit)`
- `comment(issueIdentifierOrId, body)`
- `upsertComment(issueIdentifierOrId, body, key)`
- `move(issueIdentifierOrId, stateName)`

## Normalization

Adapter outputs must match the AgentOS `Issue` model:

- `id` and `identifier` are stable strings.
- `state` is the tracker state name.
- `priority` is an integer or `null`.
- `created_at` and `updated_at` are ISO-8601 strings or `null`.
- `labels` are lowercased.
- blockers are listed in `blocked_by`; for trackers with forward `blocks`
  relations, invert them before returning the issue.
- parent and child refs are normalized issue refs when the tracker supports
  them.

Use `normalizeTrackerIssue` for adapters that already build an AgentOS-shaped
object and need final mechanical normalization.

## Errors

Adapter-specific errors may include tracker details, but should map to one of
these categories for orchestration and operator diagnostics:

- `invalid_input`
- `missing_auth`
- `transport_error`
- `rate_limited`
- `not_found`
- `permission_denied`
- `adapter_error`

`unsupported_tracker_kind` means the workflow requested an adapter that is not
registered in this AgentOS build. `workflow validate --strict` reports the known
registered adapter kinds.

## Pagination

Adapters must page through candidate and terminal queries until the requested
result set is complete for the configured project/workflow scope. Partial pages
should fail clearly rather than silently hiding eligible issues.

## Current Registry

- `linear`: Linear GraphQL adapter.

Test suites may register fake adapters with `registerTrackerAdapter` and remove
them with `unregisterTrackerAdapterForTests`.
