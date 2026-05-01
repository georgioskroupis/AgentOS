#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: scripts/agent-create-pr.sh --title <title> --body-file <path> --base <branch> --head <branch> [--draft|--ready] [--repo <owner/repo>]

Creates or returns a GitHub pull request through the non-interactive GitHub CLI.
Requires explicit title, body file, base branch, and head branch so agents do not
fall back to interactive or MCP-based PR creation.
EOF
}

title=""
body_file=""
base=""
head=""
repo=""
draft="--draft"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --title)
      title="${2:-}"
      shift 2
      ;;
    --body-file)
      body_file="${2:-}"
      shift 2
      ;;
    --base)
      base="${2:-}"
      shift 2
      ;;
    --head)
      head="${2:-}"
      shift 2
      ;;
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --draft)
      draft="--draft"
      shift
      ;;
    --ready)
      draft=""
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

missing=()
[[ -n "$title" ]] || missing+=("--title")
[[ -n "$body_file" ]] || missing+=("--body-file")
[[ -n "$base" ]] || missing+=("--base")
[[ -n "$head" ]] || missing+=("--head")

if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "missing required argument(s): ${missing[*]}" >&2
  usage
  exit 2
fi

if [[ ! -f "$body_file" ]]; then
  echo "body file does not exist: $body_file" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required: gh" >&2
  exit 127
fi

export GH_PROMPT_DISABLED=1

view_args=(pr view --head "$head" --json url --jq .url)
if [[ -n "$repo" ]]; then
  view_args=(pr view --repo "$repo" --head "$head" --json url --jq .url)
fi

existing_url="$(gh "${view_args[@]}" 2>/dev/null || true)"
if [[ -n "$existing_url" ]]; then
  printf '%s\n' "$existing_url"
  exit 0
fi

args=(pr create --title "$title" --body-file "$body_file" --base "$base" --head "$head")
if [[ -n "$repo" ]]; then
  args=(pr create --repo "$repo" --title "$title" --body-file "$body_file" --base "$base" --head "$head")
fi
if [[ -n "$draft" ]]; then
  args+=("$draft")
fi

gh "${args[@]}"
