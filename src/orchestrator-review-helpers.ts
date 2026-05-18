import { createHash } from "node:crypto";
import { summarizeCheckDiagnostics, type CheckDiagnostic, type PullRequestStatus } from "./github.js";
import { pullRequestUrls } from "./issue-state.js";
import { trustCapabilities } from "./trust.js";
import type { IssueState, PullRequestRef, ReviewFinding, ReviewTargetMode, ServiceConfig } from "./types.js";

export function formatPullRequestTargets(targets: PullRequestRef[]): string {
  if (targets.length === 0) return "- PRs: none";
  if (targets.length === 1) return `- PR: ${targets[0].url} (${targets[0].role ?? "supporting"})`;
  return ["- PRs:", ...targets.map((target) => `  - ${target.url} (${target.role ?? "supporting"})`)].join("\n");
}

export function formatRecordedPullRequests(state: IssueState): string {
  if (state.prs?.length) return formatPullRequestTargets(state.prs);
  const urls = pullRequestUrls(state);
  if (urls.length === 0) return "- PRs: none";
  if (urls.length === 1) return `- PR: ${urls[0]}`;
  return ["- PRs:", ...urls.map((url) => `  - ${url}`)].join("\n");
}

export function reviewTargetSelectionError(state: IssueState, reviewTargetMode: ReviewTargetMode): string {
  if (reviewTargetMode === "primary") {
    const primaryCount = state.prs?.filter((pr) => pr.role === "primary").length ?? 0;
    if (primaryCount === 0) return "review.target_mode=primary requires exactly one primary PR, but no primary PR was recorded.";
    return `review.target_mode=primary requires exactly one primary PR, but ${primaryCount} primary PRs were recorded.`;
  }
  return "review.target_mode=merge-eligible requires at least one primary or docs PR, but no merge-eligible PR was recorded.";
}

export function joinedHeadShas(entries: Array<{ status: Pick<PullRequestStatus, "headSha"> }>): string | null {
  const shas = [...new Set(entries.map((entry) => entry.status.headSha).filter((sha): sha is string => Boolean(sha)))];
  return shas.length ? shas.join(",") : null;
}

export function readOnlyReviewConfig(config: ServiceConfig, reviewWritableRoot: string): ServiceConfig {
  return {
    ...config,
    codex: {
      ...config.codex,
      approvalEventPolicy: "deny",
      userInputPolicy: "deny",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "workspaceWrite", writableRoots: [reviewWritableRoot], networkAccess: false }
    }
  };
}

export function reviewCheckFindings(
  status: PullRequestStatus,
  config: ServiceConfig,
  diagnostics: CheckDiagnostic[] = []
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  if (status.checkSummary.failing > 0) {
    const mechanical = diagnostics.filter((diagnostic) => diagnostic.classification === "mechanical_with_sanitized_logs");
    const humanRequired = diagnostics.filter((diagnostic) => diagnostic.classification === "ambiguous_or_logless_human_required");
    const reportOnly = diagnostics.filter((diagnostic) => diagnostic.classification === "external_or_unknown_report_only");
    const capabilities = trustCapabilities(config.trustMode);
    const canRunMechanicalCiFix = config.automation.repairPolicy === "mechanical-first" && capabilities.prNetwork;
    if (mechanical.length > 0 && canRunMechanicalCiFix) {
      findings.push({
        reviewer: "checks",
        decision: "changes_requested",
        severity: "P1",
        file: null,
        line: null,
        body: `${mechanical.length} GitHub check(s) failed mechanically with sanitized logs available. Run a bounded CI fix before human review.\n\n${summarizeCheckDiagnostics(mechanical)}`,
        findingHash: `checks-failing-mechanical-${checkDiagnosticFingerprint(mechanical)}`
      });
    }
    if (humanRequired.length > 0 || (mechanical.length > 0 && !canRunMechanicalCiFix)) {
      const unresolved = humanRequired.length > 0 ? humanRequired : mechanical;
      const reason =
        config.automation.repairPolicy !== "mechanical-first"
          ? "automation.repair_policy is conservative, so CI repair is not attempted automatically."
          : !capabilities.prNetwork
            ? `trust_mode=${config.trustMode} does not allow PR/network capability, so CI repair is not attempted automatically.`
            : "AgentOS could not classify the failed check as a mechanical failure with enough context.";
      findings.push({
        reviewer: "checks",
        decision: "human_required",
        severity: "P1",
        file: null,
        line: null,
        body: `${status.checkSummary.failing} GitHub check(s) failed. ${reason}\n\n${unresolved.length > 0 ? summarizeCheckDiagnostics(unresolved) : "No failed check logs were available."}`,
        findingHash: `checks-failing-human-${unresolved.length > 0 ? checkDiagnosticFingerprint(unresolved) : status.checkSummary.failing}`
      });
    }
    if (reportOnly.length > 0 || (diagnostics.length === 0 && mechanical.length === 0 && humanRequired.length === 0)) {
      const reported = reportOnly.length > 0 ? reportOnly : diagnostics;
      findings.push({
        reviewer: "checks",
        decision: "changes_requested",
        severity: "P3",
        file: null,
        line: null,
        body: `${reportOnly.length || status.checkSummary.failing} GitHub check(s) are external, protected, pending, or unknown to AgentOS. This is report-only diagnostic data; AgentOS will not retry checks, update branches, mark PRs ready, or merge from this classification.\n\n${reported.length > 0 ? summarizeCheckDiagnostics(reported) : "No supported check diagnostics were available."}`,
        findingHash: `checks-failing-report-only-${reported.length > 0 ? checkDiagnosticFingerprint(reported) : status.checkSummary.failing}`
      });
    }
  }
  if (config.github.requireChecks && status.checkSummary.total === 0) {
    findings.push({
      reviewer: "checks",
      decision: "changes_requested",
      severity: "P1",
      file: null,
      line: null,
      body: "No GitHub checks are present. The Wiggum loop requires at least one successful check or a human escalation.",
      findingHash: "checks-missing"
    });
  }
  if (config.github.requireChecks && status.checkSummary.total > 0 && status.checkSummary.failing === 0 && status.checkSummary.successful === 0 && status.checkSummary.pending === 0) {
    findings.push({
      reviewer: "checks",
      decision: "changes_requested",
      severity: "P1",
      file: null,
      line: null,
      body: "No successful GitHub checks are present.",
      findingHash: "checks-no-success"
    });
  }
  return findings;
}

export function handoffPullRequestValidationFinding(message: string): ReviewFinding {
  const body = `Focused fixer handoff PR metadata failed current-repository validation before state merge: ${message}`;
  return {
    reviewer: "handoff",
    decision: "human_required",
    severity: "P1",
    file: null,
    line: null,
    body,
    findingHash: createHash("sha256").update(`handoff-pr-validation\n${body}`).digest("hex").slice(0, 16)
  };
}

function checkDiagnosticFingerprint(diagnostics: CheckDiagnostic[]): string {
  const stable = diagnostics
    .map((diagnostic) =>
      [
        diagnostic.check.name,
        diagnostic.check.status ?? "",
        diagnostic.check.conclusion ?? "",
        diagnostic.classification,
        diagnostic.reason,
        diagnostic.log ? singleLine(diagnostic.log).slice(0, 1200) : ""
      ].join("\n")
    )
    .sort()
    .join("\n---\n");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

function singleLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
