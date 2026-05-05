#!/usr/bin/env bash
set -euo pipefail

mkdir -p .agent-os/runs
{
  date
  echo
  find . -maxdepth 3 -type f \( -name "*.log" -o -path "./.agent-os/runs/*" \) -print
  if [[ -n "${AGENT_LOG_PATHS:-}" ]]; then
    echo
    echo "Configured log paths:"
    for path in $AGENT_LOG_PATHS; do
      find "$path" -maxdepth 2 -type f -print 2>/dev/null || true
    done
  fi
} > .agent-os/runs/latest-log-index.txt

echo "Wrote .agent-os/runs/latest-log-index.txt"
