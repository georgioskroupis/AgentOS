#!/usr/bin/env bash
set -euo pipefail

mkdir -p .agent-os/runs
{
  date
  echo
  find . -maxdepth 3 -type f \( -name "*.log" -o -path "./.agent-os/runs/*" \) -print
} > .agent-os/runs/latest-log-index.txt

echo "Wrote .agent-os/runs/latest-log-index.txt"
