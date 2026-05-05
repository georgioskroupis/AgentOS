# Proof Of Work

Proof of work is the evidence that lets a reviewer or future agent understand
what was changed, checked, and observed.

## Evidence By Outcome

- No-PR issue: include the implementation audit, `AgentOS-Outcome:
  already-satisfied` or investigation result, validation JSON, and any relevant
  log/proof artifact.
- One-PR issue: include the PR URL, validation JSON, CI state, and app proof
  artifacts that match the touched surface.
- Investigation: include findings, commands run, data sources inspected, known
  gaps, and follow-up issue links when needed.
- UI bug: include before/after screenshots or video, browser/DOM inspection
  notes, smoke test output, and console/log evidence when available.
- API/service bug: include request/response proof, health check or smoke test,
  relevant logs, metrics or traces when configured, and CI/log links.

Use `App-Proof: <path-or-url>` or `Proof-Artifact: <path-or-url>` lines in the
handoff when an artifact should be shown by `agent-os inspect`.

