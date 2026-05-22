#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

required=(
  "README.md"
  "AGENTS.md"
  "ARCHITECTURE.md"
  "WORKFLOW.md"
  "agent-os.yml"
  ".github/workflows/ci.yml"
  "package.json"
  "tsconfig.json"
  "templates/base-harness/AGENTS.md"
  "templates/base-harness/ARCHITECTURE.md"
  "templates/base-harness/WORKFLOW.md"
  "templates/base-harness/.gitignore"
  "templates/base-harness/scripts/agent-check.sh"
  "scripts/agent-start-app.sh"
  "scripts/agent-smoke-test.sh"
  "scripts/agent-capture-logs.sh"
  "scripts/agent-capture-proof.sh"
  "templates/base-harness/scripts/agent-start-app.sh"
  "templates/base-harness/scripts/agent-smoke-test.sh"
  "templates/base-harness/scripts/agent-capture-logs.sh"
  "templates/base-harness/scripts/agent-capture-proof.sh"
  "docs/quality/APP_LEGIBILITY.md"
  "docs/quality/PROOF_OF_WORK.md"
  "docs/quality/TEST_SUITE.md"
  "templates/base-harness/docs/quality/APP_LEGIBILITY.md"
  "templates/base-harness/docs/quality/PROOF_OF_WORK.md"
  "templates/base-harness/docs/quality/TEST_SUITE.md"
  "scripts/agent-create-pr.sh"
  "templates/base-harness/scripts/agent-create-pr.sh"
  "scripts/agent-linear-comment.sh"
  "scripts/agent-linear-move.sh"
  "scripts/agent-linear-pr.sh"
  "scripts/agent-linear-handoff.sh"
  "scripts/agent-linear-plan-issues.sh"
  "templates/base-harness/scripts/agent-linear-comment.sh"
  "templates/base-harness/scripts/agent-linear-move.sh"
  "templates/base-harness/scripts/agent-linear-pr.sh"
  "templates/base-harness/scripts/agent-linear-handoff.sh"
  "templates/base-harness/scripts/agent-linear-plan-issues.sh"
  "skills/fix-bug/SKILL.md"
  "skills/implement-feature/SKILL.md"
  "skills/review-pr/SKILL.md"
  "skills/ci-diagnostics/SKILL.md"
  "skills/qa-smoke-test/SKILL.md"
  "skills/write-tests/SKILL.md"
  "skills/update-docs/SKILL.md"
  "skills/generate-exec-plan/SKILL.md"
  "skills/cleanup-tech-debt/SKILL.md"
  "templates/base-harness/.agents/skills/ci-diagnostics/SKILL.md"
  "templates/base-harness/.agents/skills/qa-smoke-test/SKILL.md"
  "templates/profiles/api/docs/quality/API.md"
  "templates/profiles/python/docs/quality/PYTHON.md"
  "templates/profiles/typescript/docs/quality/TYPESCRIPT.md"
  "templates/profiles/web/docs/quality/WEB.md"
  "bin/agent-os"
  "src/github.ts"
  "src/issue-state.ts"
  "src/project-profiler.ts"
  "src/review.ts"
  "src/setup-wizard.ts"
  "scripts/check-architecture.mjs"
  "scripts/check-harness-contract.mjs"
)

missing=0
for path in "${required[@]}"; do
  if [[ ! -e "$root/$path" ]]; then
    echo "missing: $path"
    missing=1
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "AgentOS check failed."
  exit 1
fi

bash -n "$root/bin/agent-os"
bash -n "$root/scripts/agent-check.sh"
bash -n "$root/templates/base-harness/scripts/agent-check.sh"
bash -n "$root/scripts/agent-start-app.sh"
bash -n "$root/scripts/agent-smoke-test.sh"
bash -n "$root/scripts/agent-capture-logs.sh"
bash -n "$root/scripts/agent-capture-proof.sh"
bash -n "$root/templates/base-harness/scripts/agent-start-app.sh"
bash -n "$root/templates/base-harness/scripts/agent-smoke-test.sh"
bash -n "$root/templates/base-harness/scripts/agent-capture-logs.sh"
bash -n "$root/templates/base-harness/scripts/agent-capture-proof.sh"
bash -n "$root/scripts/agent-create-pr.sh"
bash -n "$root/templates/base-harness/scripts/agent-create-pr.sh"
bash -n "$root/scripts/agent-linear-comment.sh"
bash -n "$root/scripts/agent-linear-move.sh"
bash -n "$root/scripts/agent-linear-pr.sh"
bash -n "$root/scripts/agent-linear-handoff.sh"
bash -n "$root/scripts/agent-linear-plan-issues.sh"
bash -n "$root/templates/base-harness/scripts/agent-linear-comment.sh"
bash -n "$root/templates/base-harness/scripts/agent-linear-move.sh"
bash -n "$root/templates/base-harness/scripts/agent-linear-pr.sh"
bash -n "$root/templates/base-harness/scripts/agent-linear-handoff.sh"
bash -n "$root/templates/base-harness/scripts/agent-linear-plan-issues.sh"
bash -n "$root/scripts/agent-bootstrap-worktree.sh"
bash -n "$root/templates/base-harness/scripts/agent-bootstrap-worktree.sh"
run_phase "harness contract" node "$root/scripts/check-harness-contract.mjs"

if [[ "$mode" == "structure-only" ]]; then
  echo "AgentOS structure-only check passed."
  exit 0
fi

if [[ ! -d "$root/node_modules" ]]; then
  echo "Full AgentOS check requires node_modules. Run npm ci, or use --structure-only for structural validation only." >&2
  exit 1
fi

run_phase "format check" npm --prefix "$root" run format:check
run_phase "lint" npm --prefix "$root" run lint
run_phase "typecheck" npm --prefix "$root" run typecheck
run_phase "unit/integration tests" npm --prefix "$root" run test
run_phase "coverage" npm --prefix "$root" run coverage
run_phase "build" npm --prefix "$root" run build
run_phase "architecture check" npm --prefix "$root" run check:architecture
run_phase "docs check" npm --prefix "$root" run check:docs
run_phase "security check" npm --prefix "$root" run check:security
run_phase "contract check" npm --prefix "$root" run check:contracts

echo "AgentOS check passed."
