#!/usr/bin/env bash
set -euo pipefail
mode="full"

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
  "docs/quality/QUALITY_SCORE.md"
  "docs/security/SECURITY.md"
  "docs/runbooks/README.md"
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
  if grep -q "format:check" <<<"$scripts"; then npm run format:check; fi
  if grep -q "lint" <<<"$scripts"; then npm run lint; fi
  if grep -q "typecheck" <<<"$scripts"; then npm run typecheck; fi
  if grep -q "test" <<<"$scripts"; then npm test; fi
fi

if [[ -f pyproject.toml ]]; then
  if command -v ruff >/dev/null 2>&1; then ruff check .; fi
  if command -v mypy >/dev/null 2>&1; then mypy .; fi
  if command -v pytest >/dev/null 2>&1; then pytest; fi
fi

echo "Agent harness checks passed."
