#!/usr/bin/env bash
set -euo pipefail

proof_dir="${AGENT_PROOF_DIR:-.agent-os/proof}"
mkdir -p "$proof_dir"

summary_path="$proof_dir/latest-proof.md"
{
  echo "# AgentOS Proof"
  echo
  echo "- Captured at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "- URL: ${AGENT_PROOF_URL:-not configured}"
  echo "- Start command: ${AGENT_APP_START_COMMAND:-not configured}"
  echo "- Health check: ${AGENT_HEALTH_CHECK_COMMAND:-not configured}"
  echo "- Smoke test: ${AGENT_SMOKE_COMMAND:-./scripts/agent-smoke-test.sh}"
  echo "- Logs: ${AGENT_LOG_PATHS:-.agent-os/runs app logs}"
  echo "- Metrics: ${AGENT_METRICS_COMMAND:-not configured}"
  echo "- Traces: ${AGENT_TRACES_COMMAND:-not configured}"
  echo "- CI logs: ${AGENT_CI_LOG_COMMAND:-not configured}"
  echo "- UI proof command: ${AGENT_PROOF_SCREENSHOT_COMMAND:-not configured}"
  echo "- Browser/DOM command: ${AGENT_PROOF_DOM_COMMAND:-not configured}"
} >"$summary_path"

run_optional() {
  local label="$1"
  local command_text="$2"
  local output_path="$3"
  if [[ -z "$command_text" ]]; then
    return 0
  fi
  echo "Running $label"
  if bash -lc "$command_text" >"$output_path" 2>&1; then
    echo "- $label output: $output_path" >>"$summary_path"
  else
    echo "- $label failed: $output_path" >>"$summary_path"
    return 1
  fi
}

run_optional "health check" "${AGENT_HEALTH_CHECK_COMMAND:-}" "$proof_dir/health.txt"
run_optional "metrics capture" "${AGENT_METRICS_COMMAND:-}" "$proof_dir/metrics.txt"
run_optional "trace capture" "${AGENT_TRACES_COMMAND:-}" "$proof_dir/traces.txt"
run_optional "CI log capture" "${AGENT_CI_LOG_COMMAND:-}" "$proof_dir/ci-logs.txt"
run_optional "UI screenshot/video proof" "${AGENT_PROOF_SCREENSHOT_COMMAND:-}" "$proof_dir/ui-proof.txt"
run_optional "browser/DOM inspection" "${AGENT_PROOF_DOM_COMMAND:-}" "$proof_dir/dom.txt"

echo "Wrote $summary_path"

