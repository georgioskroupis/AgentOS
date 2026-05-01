#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
  "scripts/agent-create-pr.sh"
  "templates/base-harness/scripts/agent-create-pr.sh"
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
  "bin/agent-os"
  "src/github.ts"
  "src/issue-state.ts"
  "src/project-profiler.ts"
  "src/review.ts"
  "src/setup-wizard.ts"
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
bash -n "$root/scripts/agent-create-pr.sh"
bash -n "$root/templates/base-harness/scripts/agent-create-pr.sh"
bash -n "$root/scripts/agent-bootstrap-worktree.sh"
bash -n "$root/templates/base-harness/scripts/agent-bootstrap-worktree.sh"
node "$root/scripts/check-harness-contract.mjs"

if [[ "$mode" == "structure-only" ]]; then
  echo "AgentOS structure-only check passed."
  exit 0
fi

if [[ ! -d "$root/node_modules" ]]; then
  echo "Full AgentOS check requires node_modules. Run npm ci, or use --structure-only for structural validation only." >&2
  exit 1
fi

npm --prefix "$root" run format:check
npm --prefix "$root" run lint
npm --prefix "$root" run typecheck
npm --prefix "$root" run test
npm --prefix "$root" run coverage
npm --prefix "$root" run build
npm --prefix "$root" run check:architecture
npm --prefix "$root" run check:docs
npm --prefix "$root" run check:security
npm --prefix "$root" run check:contracts

echo "AgentOS check passed."
