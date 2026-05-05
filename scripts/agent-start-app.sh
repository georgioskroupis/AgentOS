#!/usr/bin/env bash
set -euo pipefail

mkdir -p .agent-os/runs

command_text="${AGENT_APP_START_COMMAND:-}"
if [[ -z "$command_text" && -f package.json ]] && command -v node >/dev/null 2>&1; then
  command_text="$(node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const scripts = pkg.scripts || {};
for (const name of ["dev", "start", "serve"]) {
  if (scripts[name]) {
    console.log(`npm run ${name}`);
    process.exit(0);
  }
}
' 2>/dev/null || true)"
fi

if [[ -z "$command_text" ]]; then
  echo "No app start command configured. Set AGENT_APP_START_COMMAND or document one in docs/quality/APP_LEGIBILITY.md."
  exit 0
fi

log_path="${AGENT_APP_LOG_PATH:-.agent-os/runs/app.log}"
pid_path="${AGENT_APP_PID_PATH:-.agent-os/runs/app.pid}"

echo "Starting app with: $command_text"
nohup bash -lc "$command_text" >"$log_path" 2>&1 &
pid="$!"
echo "$pid" >"$pid_path"
echo "Wrote $pid_path and $log_path"

