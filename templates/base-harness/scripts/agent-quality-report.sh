#!/usr/bin/env bash
set -euo pipefail

mkdir -p docs/generated
{
  echo "# Agent Quality Report"
  echo
  date
  echo
  echo "## Harness Files"
  for path in AGENTS.md ARCHITECTURE.md WORKFLOW.md docs/product/README.md docs/quality/QUALITY_SCORE.md docs/security/SECURITY.md; do
    if [[ -e "$path" ]]; then
      echo "- present: $path"
    else
      echo "- missing: $path"
    fi
  done
} > docs/generated/agent-quality-report.md

echo "Wrote docs/generated/agent-quality-report.md"

