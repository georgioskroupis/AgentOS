import type { CheckDiagnostic, CheckDiagnosticClassification } from "./github.js";

export function classifyCiFailureLog(log: string): Pick<CheckDiagnostic, "classification" | "reason" | "operatorGuidance"> {
  const text = log.trim();
  if (!text) {
    return {
      classification: "ambiguous_or_logless_human_required",
      reason: "The failed check did not expose logs.",
      operatorGuidance: "Human action required: inspect the check provider or rerun validation manually before AgentOS attempts repair."
    };
  }
  if (/ambiguous|unclear requirement|human judgment|manual approval|requires approval|user input|approval request|elicitation|permission denied|resource not accessible|authentication|authorization|missing secret/i.test(text)) {
    return {
      classification: "ambiguous_or_logless_human_required",
      reason: "The failed check logs point to missing access, denied input, or ambiguous requirements.",
      operatorGuidance: "Human action required: resolve access, input, or requirement ambiguity before automated CI repair."
    };
  }
  if (/protected branch|required status checks?|branch protection|merge queue|merge_group|merge train|bors/i.test(text)) {
    return {
      classification: "external_or_unknown_report_only",
      reason: "The failed check logs point to protected branch, required-check, or merge-queue state rather than a retryable CI failure.",
      operatorGuidance: "Report only: resolve the branch protection or merge queue requirement outside AgentOS' flaky CI retry path."
    };
  }
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|TLS handshake timeout|npm ERR!\s+network|network error|network timeout|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout|runner (has )?lost communication|hosted runner.*lost communication|failed to download|download.*timed out|artifact service.*unavailable/i.test(text)) {
    return {
      classification: "flaky_retryable",
      reason: "Failed check logs match a supported transient infrastructure or network condition.",
      operatorGuidance: "Retryable flaky CI failure: request one bounded rerun of the failed GitHub Actions jobs before human review or code repair."
    };
  }
  if (/npm run agent-check|npm test|vitest|test failed|tests failed|assertionerror|expected .* received|error TS\d+|typescript|tsc\b|eslint|prettier|lint|syntaxerror|typeerror|referenceerror|build failed|command failed/i.test(text)) {
    return {
      classification: "mechanical_with_sanitized_logs",
      reason: "Failed check logs contain deterministic build, typecheck, lint, or test output.",
      operatorGuidance: "Fixable mechanical failure: use the sanitized, bounded, untrusted log excerpt to drive a focused CI repair."
    };
  }
  return {
    classification: "ambiguous_or_logless_human_required",
    reason: "The failed check logs were present, but AgentOS could not classify the failure as mechanical.",
    operatorGuidance: "Human action required: inspect the full CI context before deciding whether a repair turn is safe."
  };
}

export function diagnosticClassificationLabel(classification: CheckDiagnosticClassification): string {
  switch (classification) {
    case "mechanical_with_sanitized_logs":
      return "mechanical-with-sanitized-logs";
    case "flaky_retryable":
      return "flaky-retryable";
    case "ambiguous_or_logless_human_required":
      return "ambiguous-or-logless-human-required";
    case "external_or_unknown_report_only":
      return "external-or-unknown-report-only";
    case "successful":
      return "successful";
  }
}
