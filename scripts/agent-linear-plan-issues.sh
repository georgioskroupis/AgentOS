#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${AGENT_OS_SOURCE_REPO:-}" && -x "$AGENT_OS_SOURCE_REPO/bin/agent-os" ]]; then
  agent_os=("$AGENT_OS_SOURCE_REPO/bin/agent-os")
elif command -v agent-os >/dev/null 2>&1; then
  agent_os=("agent-os")
else
  echo "AgentOS CLI is required: install agent-os on PATH or set AGENT_OS_SOURCE_REPO" >&2
  exit 127
fi

exec "${agent_os[@]}" linear plan-issues "$@" --repo "$repo_root" --workflow WORKFLOW.md
