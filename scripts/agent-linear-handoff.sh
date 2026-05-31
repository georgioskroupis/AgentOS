#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_name="$(basename "$0")"

resolve_source_repo_from_git() {
  local common_dir candidate
  common_dir="$(git -C "$repo_root" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ -n "$common_dir" ]] || return 1
  case "$common_dir" in
    /*) ;;
    *) common_dir="$repo_root/$common_dir" ;;
  esac
  common_dir="$(cd "$common_dir" 2>/dev/null && pwd -P || true)"
  [[ -n "$common_dir" && "$(basename "$common_dir")" == ".git" ]] || return 1
  candidate="$(cd "$(dirname "$common_dir")" && pwd -P)"
  [[ -x "$candidate/bin/agent-os" ]] || return 1
  printf '%s\n' "$candidate"
}

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

source_repo="${AGENT_OS_SOURCE_REPO:-}"
if [[ -z "$source_repo" || ! -x "$source_repo/bin/agent-os" ]]; then
  source_repo="$(resolve_source_repo_from_git || true)"
fi

if [[ -n "$source_repo" && -x "$source_repo/bin/agent-os" ]]; then
  export AGENT_OS_SOURCE_REPO="$source_repo"
  if [[ -f "$source_repo/.agent-os/env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$source_repo/.agent-os/env"
    set +a
    export AGENT_OS_SOURCE_REPO="$source_repo"
  fi
  agent_os=("$source_repo/bin/agent-os")
elif command -v agent-os >/dev/null 2>&1; then
  agent_os=("agent-os")
else
  echo "AgentOS CLI is required: install agent-os on PATH or set AGENT_OS_SOURCE_REPO" >&2
  exit 127
fi

exec "${agent_os[@]}" linear lifecycle "$action" "$@" --repo "$repo_root" --workflow WORKFLOW.md --tool "scripts/$script_name"
