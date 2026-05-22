#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-4317}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec "$ROOT/bin/agent-os" orchestrator run \
  --repo "$ROOT" \
  --workflow WORKFLOW.md \
  --port "$PORT"
