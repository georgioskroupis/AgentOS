#!/usr/bin/env bash
set -euo pipefail
mode="full"
heartbeat_seconds="${AGENT_CHECK_HEARTBEAT_SECONDS:-30}"

case "$heartbeat_seconds" in
  ''|*[!0-9]*)
    heartbeat_seconds=30
    ;;
esac

if [[ "$heartbeat_seconds" -lt 1 ]]; then
  heartbeat_seconds=30
fi

run_phase() {
  local label="$1"
  shift
  local started_at now elapsed rc pid heartbeat_pid
  started_at="$(date +%s)"
  echo "==> ${label} started"
  "$@" &
  pid="$!"
  (
    while sleep "$heartbeat_seconds"; do
      if kill -0 "$pid" 2>/dev/null; then
        now="$(date +%s)"
        echo "==> ${label} still running after $((now - started_at))s"
      else
        exit 0
      fi
    done
  ) &
  heartbeat_pid="$!"
  if wait "$pid"; then
    rc=0
  else
    rc="$?"
  fi
  kill "$heartbeat_pid" >/dev/null 2>&1 || true
  wait "$heartbeat_pid" 2>/dev/null || true
  now="$(date +%s)"
  elapsed="$((now - started_at))"
  if [[ "$rc" -eq 0 ]]; then
    echo "==> ${label} passed in ${elapsed}s"
  else
    echo "==> ${label} failed in ${elapsed}s"
  fi
  return "$rc"
}

case "${1:-}" in
  --structure-only)
    mode="structure-only"
    ;;
  "")
    ;;
  *)
    echo "usage: scripts/agent-check.sh [--structure-only]" >&2
    exit 2
    ;;
esac

echo "==> Harness file check"

required=(
  "AGENTS.md"
  "ARCHITECTURE.md"
  "WORKFLOW.md"
  "docs/README.md"
  "docs/product/README.md"
  "docs/architecture/README.md"
  "docs/decisions/README.md"
  "docs/quality/APP_LEGIBILITY.md"
  "docs/quality/PROOF_OF_WORK.md"
  "docs/quality/QUALITY_SCORE.md"
  "docs/quality/TEST_SUITE.md"
  "docs/security/SECURITY.md"
  "docs/runbooks/README.md"
  "scripts/agent-linear-comment.sh"
  "scripts/agent-linear-move.sh"
  "scripts/agent-linear-pr.sh"
  "scripts/agent-linear-handoff.sh"
  "scripts/agent-linear-plan-issues.sh"
  "scripts/agent-start-app.sh"
  "scripts/agent-smoke-test.sh"
  "scripts/agent-capture-logs.sh"
  "scripts/agent-capture-proof.sh"
  ".agents/skills/fix-bug/SKILL.md"
  ".agents/skills/implement-feature/SKILL.md"
  ".agents/skills/review-pr/SKILL.md"
  ".agents/skills/ci-diagnostics/SKILL.md"
  ".agents/skills/qa-smoke-test/SKILL.md"
  ".agents/skills/write-tests/SKILL.md"
  ".agents/skills/update-docs/SKILL.md"
  ".agents/skills/generate-exec-plan/SKILL.md"
  ".agents/skills/cleanup-tech-debt/SKILL.md"
)

missing=0
for path in "${required[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "missing: $path"
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "Harness check failed."
  exit 1
fi

if [[ "$mode" == "structure-only" ]]; then
  echo "Agent harness structure-only checks passed."
  exit 0
fi

if [[ -f package.json ]]; then
  if [[ ! -d node_modules ]]; then
    echo "Full harness check requires node_modules. Run npm ci, or use --structure-only for structural validation only." >&2
    exit 1
  fi
  scripts="$(npm run 2>/dev/null || true)"
  if grep -q "format:check" <<<"$scripts"; then run_phase "format check" npm run format:check; fi
  if grep -q "lint" <<<"$scripts"; then run_phase "lint" npm run lint; fi
  if grep -q "typecheck" <<<"$scripts"; then run_phase "typecheck" npm run typecheck; fi
  if grep -q "test" <<<"$scripts"; then run_phase "tests" npm test; fi
fi

if [[ -f pyproject.toml ]]; then
  if command -v ruff >/dev/null 2>&1; then run_phase "ruff" ruff check .; fi
  if command -v mypy >/dev/null 2>&1; then run_phase "mypy" mypy .; fi
  if command -v pytest >/dev/null 2>&1; then run_phase "pytest" pytest; fi
fi

echo "Agent harness checks passed."
