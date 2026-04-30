#!/usr/bin/env bash
set -euo pipefail

if [[ -f package.json ]]; then
  npm test -- --runInBand 2>/dev/null || npm test
elif [[ -f pyproject.toml ]] && command -v pytest >/dev/null 2>&1; then
  pytest
else
  echo "No project-specific smoke test configured."
fi
