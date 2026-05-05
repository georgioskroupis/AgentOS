#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${AGENT_SMOKE_COMMAND:-}" ]]; then
  bash -lc "$AGENT_SMOKE_COMMAND"
elif [[ -f package.json ]]; then
  npm test -- --runInBand 2>/dev/null || npm test
elif [[ -f pyproject.toml ]] && command -v pytest >/dev/null 2>&1; then
  pytest
else
  echo "No project-specific smoke test configured."
fi

if [[ -n "${AGENT_HEALTH_CHECK_COMMAND:-}" ]]; then
  bash -lc "$AGENT_HEALTH_CHECK_COMMAND"
fi
