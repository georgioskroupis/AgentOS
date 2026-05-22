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
    echo "Commit, stash, or remove unrelated dirty files before retrying." >&2
    echo "Use AGENT_OS_ALLOW_DIRTY_WORKTREE=1 only for operator-supervised recovery when the dirty files are known to be irrelevant." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$workspace")"
  branch="agent/${workspace_key}"
  if [[ -d "$workspace" && -n "$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "Refusing to create AgentOS workspace in a non-empty directory without an existing worktree." >&2
    echo "Inspect or remove $workspace before retrying." >&2
    exit 1
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
