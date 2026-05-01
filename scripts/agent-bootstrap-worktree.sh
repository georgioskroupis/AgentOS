#!/usr/bin/env bash
set -euo pipefail

source_repo="${AGENT_OS_SOURCE_REPO:?AGENT_OS_SOURCE_REPO is required}"
workspace="${AGENT_OS_WORKSPACE:?AGENT_OS_WORKSPACE is required}"
workspace_key="${AGENT_OS_WORKSPACE_KEY:?AGENT_OS_WORKSPACE_KEY is required}"

if [[ -d "$workspace/.git" || -f "$workspace/.git" ]]; then
  exit 0
fi

if git -C "$source_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [[ "${AGENT_OS_ALLOW_DIRTY_WORKTREE:-}" != "1" ]] && [[ -n "$(git -C "$source_repo" status --porcelain)" ]]; then
    echo "Refusing to create AgentOS workspace from a dirty source worktree." >&2
    echo "Commit, stash, or set AGENT_OS_ALLOW_DIRTY_WORKTREE=1 to override explicitly." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$workspace")"
  branch="agent/${workspace_key}"
  if [[ -d "$workspace" ]]; then
    rmdir "$workspace" 2>/dev/null || true
  fi
  git -C "$source_repo" worktree add -B "$branch" "$workspace" HEAD
else
  mkdir -p "$workspace"
  rsync -a \
    --exclude ".agent-os" \
    --exclude "node_modules" \
    --exclude "dist" \
    "$source_repo"/ "$workspace"/
fi
