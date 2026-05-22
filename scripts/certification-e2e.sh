#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="${AGENT_OS_CERTIFICATION_WORKFLOW:-$root/WORKFLOW.md}"
team="${AGENT_OS_CERTIFICATION_TEAM:-VER}"

if [[ "${AGENT_OS_CERTIFICATION_LIVE:-}" != "1" ]]; then
  cat <<'EOF'
AgentOS live E2E certification skipped.

Set AGENT_OS_CERTIFICATION_LIVE=1 to run the credentialed certification gate.
For dispatch, also provide an isolated AGENT_OS_CERTIFICATION_WORKFLOW and set
AGENT_OS_CERTIFICATION_DISPATCH=1 with AGENT_OS_CERTIFICATION_ACK=dispatch:<issue>.
EOF
  exit 0
fi

if [[ -z "${LINEAR_API_KEY:-}" ]]; then
  echo "LINEAR_API_KEY is required for live certification." >&2
  exit 2
fi

"$root/bin/agent-os" workflow validate --strict "$workflow"
"$root/bin/agent-os" doctor "$root" --workflow "$workflow"
"$root/bin/agent-os" linear doctor --team "$team" --workflow "$workflow"

if [[ "${AGENT_OS_CERTIFICATION_DISPATCH:-}" != "1" ]]; then
  echo "Live certification preflight passed; dispatch was not requested."
  exit 0
fi

if [[ -z "${AGENT_OS_CERTIFICATION_ISSUE:-}" ]]; then
  echo "AGENT_OS_CERTIFICATION_ISSUE is required when dispatch is enabled." >&2
  exit 2
fi

if [[ -z "${AGENT_OS_CERTIFICATION_WORKFLOW:-}" ]]; then
  echo "AGENT_OS_CERTIFICATION_WORKFLOW must point at an isolated certification workflow before dispatch." >&2
  exit 2
fi

expected_ack="dispatch:${AGENT_OS_CERTIFICATION_ISSUE}"
if [[ "${AGENT_OS_CERTIFICATION_ACK:-}" != "$expected_ack" ]]; then
  echo "Refusing live dispatch without AGENT_OS_CERTIFICATION_ACK=$expected_ack." >&2
  exit 2
fi

"$root/bin/agent-os" orchestrator once --repo "$root" --workflow "$workflow"
echo "Live certification dispatch completed for ${AGENT_OS_CERTIFICATION_ISSUE}."
