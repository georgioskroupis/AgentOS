#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required=(
  "README.md"
  "AGENTS.md"
  "ARCHITECTURE.md"
  "WORKFLOW.md"
  "agent-os.yml"
  "package.json"
  "tsconfig.json"
  "templates/base-harness/AGENTS.md"
  "templates/base-harness/ARCHITECTURE.md"
  "templates/base-harness/WORKFLOW.md"
  "templates/base-harness/scripts/agent-check.sh"
  "skills/fix-bug/SKILL.md"
  "skills/implement-feature/SKILL.md"
  "skills/review-pr/SKILL.md"
  "skills/write-tests/SKILL.md"
  "skills/update-docs/SKILL.md"
  "skills/generate-exec-plan/SKILL.md"
  "skills/cleanup-tech-debt/SKILL.md"
  "bin/agent-os"
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
bash -n "$root/scripts/agent-bootstrap-worktree.sh"
bash -n "$root/templates/base-harness/scripts/agent-bootstrap-worktree.sh"

if [[ -d "$root/node_modules" ]]; then
  npm --prefix "$root" run typecheck
  npm --prefix "$root" test
  npm --prefix "$root" run build
else
  echo "Skipping npm checks because node_modules is not installed."
fi

echo "AgentOS check passed."
