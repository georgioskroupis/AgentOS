#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_name="$(basename "$0")"

case "$script_name" in
  agent-linear-comment.sh) action="comment" ;;
  agent-linear-move.sh) action="move" ;;
  agent-linear-pr.sh) action="attach-pr" ;;
  agent-linear-handoff.sh) action="record-handoff" ;;
  *)
    echo "unsupported AgentOS Linear lifecycle wrapper: $script_name" >&2
    exit 2
    ;;
esac

if [[ -n "${AGENT_OS_SOURCE_REPO:-}" && -x "$AGENT_OS_SOURCE_REPO/bin/agent-os" ]]; then
  agent_os=("$AGENT_OS_SOURCE_REPO/bin/agent-os")
elif command -v agent-os >/dev/null 2>&1; then
  agent_os=("agent-os")
else
  echo "AgentOS CLI is required: install agent-os on PATH or set AGENT_OS_SOURCE_REPO" >&2
  exit 127
fi

exec "${agent_os[@]}" linear lifecycle "$action" "$@" --repo "$repo_root" --workflow WORKFLOW.md --tool "scripts/$script_name"
