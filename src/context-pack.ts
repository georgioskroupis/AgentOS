import { redactText } from "./redaction.js";
import type { CheckDiagnostic, PullRequestStatus, ReviewThread } from "./github.js";
import type { HumanDecisionState, Issue, IssueState, PullRequestRef, ReviewFinding, ReviewStateReviewer, ValidationState } from "./types.js";

export type ContextPackKind = "implementation-reentry" | "reviewer" | "fixer" | "ci-repair";

export interface PullRequestContextEntry {
  target?: PullRequestRef;
  url?: string;
  status?: PullRequestStatus | null;
  diff?: string | null;
  threads?: ReviewThread[];
  checkDiagnostics?: CheckDiagnostic[];
}

export interface TargetedContextPackInput {
  kind: ContextPackKind;
  issue: Issue;
  state?: IssueState | null;
  pullRequests?: PullRequestContextEntry[];
  findings?: ReviewFinding[];
  validation?: ValidationState | null;
  feedback?: string | null;
  artifactRefs?: string[];
  runId?: string | null;
  reviewer?: string;
  iteration?: number;
}

const LIMITS = {
  issueDescription: 4_000,
  feedback: 4_000,
  diff: 12_000,
  findingBody: 2_000,
  decisionSummary: 800,
  ciLog: 1_200
} as const;

export function buildTargetedContextPack(input: TargetedContextPackInput): string {
  const state = input.state ?? null;
  const pullRequests = input.pullRequests ?? [];
  const validation = input.validation ?? state?.validation ?? null;
  const findings = input.findings ?? [];
  const lines = [
    "## AgentOS Targeted Context Pack",
    "",
    `Pack kind: ${input.kind}`,
    input.runId ? `Run ID: ${input.runId}` : null,
    input.iteration ? `Review iteration: ${input.iteration}` : null,
    input.reviewer ? `Reviewer: ${input.reviewer}` : null,
    "",
    "Issue text:",
    ...formatIssue(input.issue),
    "",
    "Recent authoritative human decisions:",
    ...formatHumanDecisions(recentHumanDecisions(state)),
    "",
    "Selected PR metadata:",
    ...formatPullRequests(pullRequests),
    "",
    "Validation summary:",
    ...formatValidation(validation),
    "",
    "Current findings:",
    ...formatFindingsForContext(findings),
    "",
    "Sanitized CI/log excerpts:",
    ...formatCiLogExcerpts(pullRequests),
    input.feedback
      ? [
          "",
          "Recent PR/review feedback (bounded):",
          indentBlock(boundContextText(input.feedback, LIMITS.feedback, "PR comments and review threads"))
        ].join("\n")
      : null,
    "",
    "Artifact references:",
    ...formatArtifactReferences(input, pullRequests, validation)
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

export function pullRequestRefsForUrls(state: IssueState | null, urls: string[]): PullRequestRef[] {
  const known = new Map((state?.prs ?? []).map((ref) => [ref.url, ref]));
  return urls.map((url) => known.get(url) ?? { url, source: "manual", discoveredAt: state?.updatedAt ?? new Date().toISOString() });
}

export function pullRequestContextEntriesForUrls(state: IssueState | null, urls: string[]): PullRequestContextEntry[] {
  return pullRequestRefsForUrls(state, urls).map((target) => ({ target }));
}

function formatIssue(issue: Issue): string[] {
  return [
    `- Identifier: ${issue.identifier}`,
    `- Title: ${cleanSingleLine(issue.title, 500)}`,
    `- State: ${issue.state}`,
    issue.url ? `- URL: ${issue.url}` : null,
    issue.branch_name ? `- Branch: ${issue.branch_name}` : null,
    issue.labels.length ? `- Labels: ${issue.labels.join(", ")}` : null,
    issue.description
      ? ["- Description excerpt:", indentBlock(boundContextText(issue.description, LIMITS.issueDescription, "Linear issue description"))].join("\n")
      : "- Description excerpt: none"
  ].filter((line): line is string => line !== null);
}

function recentHumanDecisions(state: IssueState | null): HumanDecisionState[] {
  const byKey = new Map<string, HumanDecisionState>();
  for (const decision of [...(state?.humanDecisions ?? []), ...(state?.lastHumanDecision ? [state.lastHumanDecision] : [])]) {
    byKey.set(decision.commentId ? `comment:${decision.commentId}` : `${decision.source}:${decision.decidedAt}:${decision.type}`, decision);
  }
  return [...byKey.values()].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt)).slice(-3);
}

function formatHumanDecisions(decisions: HumanDecisionState[]): string[] {
  if (decisions.length === 0) return ["- none recorded"];
  return decisions.flatMap((decision) => [
    `- ${decision.type} at ${decision.decidedAt}${decision.actor ? ` by ${cleanSingleLine(decision.actor, 120)}` : ""}`,
    decision.prHeadSha ? `  PR head SHA: ${decision.prHeadSha}` : null,
    decision.validationEvidence ? `  Validation evidence: ${decision.validationEvidence}` : null,
    decision.ciState ? `  CI state: ${decision.ciState}` : null,
    decision.findings ? `  Findings: ${decision.findings}` : null,
    decision.summary ? `  Summary: ${cleanSingleLine(decision.summary, LIMITS.decisionSummary)}` : null
  ].filter((line): line is string => line !== null));
}

function formatPullRequests(entries: PullRequestContextEntry[]): string[] {
  if (entries.length === 0) return ["- none selected"];
  return entries.flatMap((entry) => {
    const status = entry.status ?? null;
    const url = entryUrl(entry);
    const target = entry.target;
    const threads = entry.threads ?? [];
    const unresolvedThreads = threads.filter((thread) => !thread.isResolved).slice(0, 10);
    return [
      `- PR: ${url}`,
      target?.role ? `  Role: ${target.role}` : null,
      status
        ? [
            `  State: ${status.state || "unknown"}${status.isDraft ? " draft" : ""}`,
            `  Mergeable: ${status.mergeable ?? "unknown"}`,
            `  Base: ${status.baseRefName ?? "unknown"}`,
            `  Head: ${status.headRefName ?? "unknown"}${status.headSha ? ` ${status.headSha}` : ""}`,
            `  Review decision: ${status.reviewDecision ?? "unknown"}`,
            `  Changed files: ${boundedList(status.changedFiles, 20)}`,
            `  Checks: total=${status.checkSummary.total} successful=${status.checkSummary.successful} pending=${status.checkSummary.pending} failing=${status.checkSummary.failing}`,
            status.checkDetails.length
              ? `  Check details: ${status.checkDetails.slice(0, 12).map((check) => `${check.name}=${check.status ?? check.state ?? "unknown"}/${check.conclusion ?? "unknown"}`).join("; ")}${status.checkDetails.length > 12 ? `; ... ${status.checkDetails.length - 12} more` : ""}`
              : "  Check details: none reported",
            unresolvedThreads.length ? ["  Unresolved review threads:", indentBlock(formatThreads(unresolvedThreads), 4)].join("\n") : "  Unresolved review threads: none reported",
            formatDiffExcerpt(entry)
          ]
        : "  Metadata: PR status was not fetched for this pack"
    ].filter((line): line is string => line !== null);
  });
}

function formatDiffExcerpt(entry: PullRequestContextEntry): string | null {
  if (entry.diff == null) return null;
  const url = entryUrl(entry);
  const reference = `gh pr diff ${url}`;
  const diff = entry.diff.trim();
  if (!diff) return `  Diff excerpt: none reported (full diff reference: \`${reference}\`)`;
  if (/^Could not fetch diff:/i.test(diff)) return `  Diff excerpt: ${cleanSingleLine(diff, 600)}`;
  return [
    "  Diff excerpt (bounded):",
    "  ```diff",
    indentBlock(boundContextText(diff, LIMITS.diff, reference), 2),
    "  ```"
  ].join("\n");
}

function formatValidation(validation: ValidationState | null): string[] {
  if (!validation) return ["- none recorded"];
  return [
    `- Status: ${validation.status}${validation.finalStatus ? ` final=${validation.finalStatus}` : ""}`,
    validation.path ? `- Evidence: ${validation.path}` : null,
    validation.acceptedCommands?.length ? `- Passing required commands: ${validation.acceptedCommands.map((command) => command.name).join(", ")}` : null,
    validation.additionalPassingCommands?.length ? `- Additional passing commands: ${validation.additionalPassingCommands.map((command) => command.name).join(", ")}` : null,
    validation.failedHistoricalAttempts?.length ? `- Failed historical attempts: ${validation.failedHistoricalAttempts.map((command) => `${command.name} exit ${command.exitCode}`).join(", ")}` : null,
    validation.githubCi ? `- GitHub CI: ${validation.githubCi.status}${validation.githubCi.headSha ? ` ${validation.githubCi.headSha}` : ""}` : null,
    validation.errors?.length ? `- Errors: ${validation.errors.map((error) => cleanSingleLine(error, 400)).join("; ")}` : null
  ].filter((line): line is string => line !== null);
}

function formatFindingsForContext(findings: ReviewFinding[]): string[] {
  if (findings.length === 0) return ["- none recorded"];
  return findings.slice(0, 20).map((finding) => {
    const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "general";
    return `- ${finding.severity} ${finding.reviewer} ${location} [${finding.findingHash}]: ${boundContextText(finding.body, LIMITS.findingBody, "review artifact finding")}`;
  });
}

function formatCiLogExcerpts(entries: PullRequestContextEntry[]): string[] {
  const diagnostics = entries.flatMap((entry) => entry.checkDiagnostics ?? []);
  const withLogs = diagnostics.filter((diagnostic) => diagnostic.log);
  if (withLogs.length === 0) return ["- none included"];
  return withLogs.slice(0, 10).map((diagnostic) => {
    const log = boundContextText(diagnostic.log ?? "", LIMITS.ciLog, diagnostic.check.url ?? `GitHub check ${diagnostic.check.name}`);
    return `- ${diagnostic.check.name}: ${diagnostic.classification}; ${cleanSingleLine(diagnostic.reason, 400)}\n${indentBlock(log, 2)}`;
  });
}

function formatArtifactReferences(input: TargetedContextPackInput, entries: PullRequestContextEntry[], validation: ValidationState | null): string[] {
  const refs = new Set<string>();
  for (const ref of input.artifactRefs ?? []) {
    if (ref.trim()) refs.add(ref.trim());
  }
  if (input.runId) {
    refs.add(`.agent-os/runs/${input.runId}/prompt.md`);
    refs.add(`.agent-os/runs/${input.runId}/events.jsonl`);
  }
  if (validation?.path) refs.add(validation.path);
  for (const reviewer of input.state?.reviewers ?? []) {
    const artifactPath = reviewArtifactRef(reviewer);
    if (artifactPath) refs.add(artifactPath);
  }
  for (const entry of entries) {
    const url = entryUrl(entry);
    if (url !== "unknown") refs.add(`Full PR diff: gh pr diff ${url}`);
    for (const diagnostic of entry.checkDiagnostics ?? []) {
      if (diagnostic.check.url) refs.add(`Failed check: ${diagnostic.check.url}`);
    }
  }
  return refs.size ? [...refs].map((ref) => `- ${ref}`) : ["- none"];
}

function reviewArtifactRef(reviewer: ReviewStateReviewer): string | null {
  return reviewer.artifactPath?.trim() || null;
}

function formatThreads(threads: ReviewThread[]): string {
  return threads
    .map((thread) => {
      const comments = thread.comments.map((comment) => cleanSingleLine(comment.body, 240)).join(" | ");
      return `- ${thread.path ?? "unknown"}${thread.line ? `:${thread.line}` : ""}: ${comments || "no comment body"}`;
    })
    .join("\n");
}

function entryUrl(entry: PullRequestContextEntry): string {
  return entry.target?.url ?? entry.status?.url ?? entry.url ?? "unknown";
}

function boundedList(values: string[], max: number): string {
  if (values.length === 0) return "none reported";
  const selected = values.slice(0, max).join(", ");
  return values.length > max ? `${selected}, ... ${values.length - max} more` : selected;
}

function boundContextText(value: string, maxLength: number, reference: string): string {
  const redacted = redactText(value).trim();
  if (redacted.length <= maxLength) return redacted;
  const suffix = `\n[truncated; full context reference: ${reference}]`;
  return `${redacted.slice(0, Math.max(0, maxLength - suffix.length)).trimEnd()}${suffix}`;
}

function cleanSingleLine(value: string, maxLength: number): string {
  const redacted = redactText(value).trim().replace(/\s+/g, " ");
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 15)).trimEnd()}... [truncated]`;
}

function indentBlock(text: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
