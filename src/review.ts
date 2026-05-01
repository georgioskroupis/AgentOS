import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { ensureDir, exists, readText, writeTextEnsuringDir } from "./fs-utils.js";
import type { Issue, ReviewFinding, ReviewStateReviewer, ReviewStatus, ServiceConfig } from "./types.js";

export const REVIEW_ARTIFACT_SCHEMA_VERSION = 1;

export interface ReviewerArtifact {
  schemaVersion?: 1;
  reviewer: string;
  decision: ReviewStatus;
  findings: ReviewFinding[];
  summary?: string;
}

export interface ReviewContext {
  issue: Issue;
  prUrl: string;
  iteration: number;
  reviewer: string;
  artifactPath: string;
  githubSummary: string;
  feedbackSummary?: string;
}

export function isBlockingFinding(finding: ReviewFinding, config: ServiceConfig): boolean {
  return config.review.blockingSeverities.includes(finding.severity as "P0" | "P1" | "P2");
}

export function blockingFindings(findings: ReviewFinding[], config: ServiceConfig): ReviewFinding[] {
  return findings.filter((finding) => isBlockingFinding(finding, config));
}

export function findingHash(input: Omit<ReviewFinding, "findingHash"> | ReviewFinding): string {
  const stable = [
    input.reviewer,
    input.severity,
    input.file ?? "",
    input.line ?? "",
    input.body.trim().replace(/\s+/g, " ")
  ].join("\n");
  return createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export function normalizeFinding(raw: unknown, reviewer: string, decision: ReviewFinding["decision"]): ReviewFinding | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const severity: ReviewFinding["severity"] = item.severity === "P0" || item.severity === "P1" || item.severity === "P2" || item.severity === "P3" ? item.severity : "P3";
  const body = typeof item.body === "string" ? item.body.trim() : "";
  if (!body) return null;
  const file = typeof item.file === "string" && item.file.trim() ? item.file.trim() : null;
  const line = typeof item.line === "number" && Number.isInteger(item.line) ? item.line : null;
  const base = {
    reviewer: typeof item.reviewer === "string" ? item.reviewer : reviewer,
    decision,
    severity,
    file,
    line,
    body
  };
  return {
    ...base,
    findingHash: typeof item.findingHash === "string" && item.findingHash ? item.findingHash : findingHash(base)
  };
}

export async function writeReviewArtifact(path: string, artifact: ReviewerArtifact): Promise<void> {
  await writeTextEnsuringDir(path, `${JSON.stringify({ ...artifact, schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION }, null, 2)}\n`);
}

export async function readReviewArtifact(path: string, reviewer: string): Promise<ReviewerArtifact> {
  if (!(await exists(path))) {
    return {
      schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
      reviewer,
      decision: "human_required",
      summary: "Reviewer did not produce the required machine-readable artifact.",
      findings: [
        {
          reviewer,
          decision: "human_required",
          severity: "P1",
          file: null,
          line: null,
          body: `Reviewer ${reviewer} did not write ${path}.`,
          findingHash: findingHash({
            reviewer,
            decision: "human_required",
            severity: "P1",
            file: null,
            line: null,
            body: `Reviewer ${reviewer} did not write ${path}.`
          })
        }
      ]
    };
  }
  const parsed = JSON.parse(await readText(path)) as Record<string, unknown>;
  const decision = parsed.decision === "approved" || parsed.decision === "changes_requested" || parsed.decision === "human_required" ? parsed.decision : "human_required";
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.map((finding) => normalizeFinding(finding, reviewer, decision)).filter((finding): finding is ReviewFinding => Boolean(finding))
    : [];
  return {
    schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
    reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : reviewer,
    decision,
    findings,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined
  };
}

export function reviewArtifactPath(repoRoot: string, issueIdentifier: string, iteration: number, reviewer: string): string {
  return join(repoRoot, ".agent-os", "reviews", safeFileName(issueIdentifier), `iteration-${iteration}`, `${safeFileName(reviewer)}.json`);
}

export async function ensureReviewIterationDir(repoRoot: string, issueIdentifier: string, iteration: number): Promise<string> {
  const dir = join(repoRoot, ".agent-os", "reviews", safeFileName(issueIdentifier), `iteration-${iteration}`);
  await ensureDir(dir);
  return dir;
}

export function reviewerPrompt(context: ReviewContext): string {
  return [
    `You are the ${context.reviewer} automated reviewer for ${context.issue.identifier}.`,
    "",
    "This is a read-only Ralph Wiggum review pass. Do not edit files, create commits, push branches, move Linear issues, or comment in Linear.",
    "",
    "Review target:",
    `- Issue: ${context.issue.identifier} ${context.issue.title}`,
    `- PR: ${context.prUrl}`,
    `- Iteration: ${context.iteration}`,
    "",
    "GitHub context:",
    context.githubSummary,
    context.feedbackSummary ? ["", "Recent feedback:", context.feedbackSummary].join("\n") : "",
    "",
    "Reviewer focus:",
    reviewerFocus(context.reviewer),
    "",
    "Write exactly one JSON file at:",
    context.artifactPath,
    "",
    "Schema:",
    [
      "{",
      '  "schemaVersion": 1,',
      '  "reviewer": "self|correctness|tests|architecture|security",',
      '  "decision": "approved|changes_requested|human_required",',
      '  "summary": "short summary",',
      '  "findings": [',
      "    {",
      '      "severity": "P0|P1|P2|P3",',
      '      "file": "path or null",',
      '      "line": 123,',
      '      "body": "specific actionable finding"',
      "    }",
      "  ]",
      "}"
    ].join("\n"),
    "",
    "Use P0, P1, or P2 only for findings that must be fixed before human review. Use P3 for suggestions."
  ]
    .filter(Boolean)
    .join("\n");
}

export function fixPrompt(input: {
  issue: Issue;
  prUrl: string;
  iteration: number;
  findings: ReviewFinding[];
  handoffPath: string;
  feedbackSummary?: string;
}): string {
  return [
    `You are fixing blocking automated review findings for ${input.issue.identifier}.`,
    "",
    "Stay on the existing branch and update the existing pull request. Do not start a parallel implementation.",
    `PR: ${input.prUrl}`,
    `Iteration: ${input.iteration}`,
    input.feedbackSummary ? ["", "Human/agent feedback to include:", input.feedbackSummary].join("\n") : "",
    "",
    "Blocking findings:",
    JSON.stringify(input.findings, null, 2),
    "",
    "Responsibilities:",
    "1. Change only what is needed to address the blocking findings.",
    "2. Preserve public behavior unless a finding explicitly requires it.",
    "3. Run `npm run agent-check`.",
    "4. Push the branch and update the existing PR.",
    `5. Update the handoff file at ${input.handoffPath} with the latest validation and PR URL.`,
    "6. Do not move or comment on the Linear issue directly; AgentOS owns Linear lifecycle updates."
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeReviewArtifacts(artifacts: ReviewerArtifact[], config: ServiceConfig): {
  status: ReviewStatus;
  findings: ReviewFinding[];
  reviewers: ReviewStateReviewer[];
} {
  const findings = artifacts.flatMap((artifact) => artifact.findings);
  const blocking = blockingFindings(findings, config);
  const humanRequired = artifacts.some((artifact) => artifact.decision === "human_required");
  const changesRequested = artifacts.some((artifact) => artifact.decision === "changes_requested") || blocking.length > 0;
  const status: ReviewStatus = humanRequired ? "human_required" : changesRequested ? "changes_requested" : "approved";
  return {
    status,
    findings,
    reviewers: artifacts.map((artifact, index) => ({
      name: artifact.reviewer,
      decision: artifact.decision,
      iteration: index
    }))
  };
}

export function repeatedBlockingHashes(previous: ReviewFinding[] | undefined, current: ReviewFinding[], config: ServiceConfig): string[] {
  const oldHashes = new Set(blockingFindings(previous ?? [], config).map((finding) => finding.findingHash));
  return blockingFindings(current, config)
    .map((finding) => finding.findingHash)
    .filter((hash) => oldHashes.has(hash));
}

export function formatFindings(findings: ReviewFinding[], repoRoot: string): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((finding) => {
      const file = finding.file ? relative(repoRoot, finding.file).replace(/^\.\.\//, finding.file) : "general";
      const line = finding.line ? `:${finding.line}` : "";
      return `- ${finding.severity} ${finding.reviewer} ${file}${line}: ${finding.body}`;
    })
    .join("\n");
}

function reviewerFocus(reviewer: string): string {
  switch (reviewer) {
    case "self":
      return "Review the diff as if you authored it. Look for mistakes, incomplete acceptance criteria, missing handoff details, and accidental scope creep.";
    case "correctness":
      return "Check behavior, edge cases, compatibility, idempotency, and failure handling against the Linear issue.";
    case "tests":
      return "Check whether validation is meaningful, deterministic, narrow enough for the change, and covered by the harness.";
    case "architecture":
      return "Check AgentOS boundaries, duplicate concepts, workflow naming drift, public command documentation, and maintainability.";
    case "security":
      return "Check secrets, auth, external API calls, shell execution, permissions, and configuration safety.";
    default:
      return "Check for blocking defects and actionable improvements in your named area.";
  }
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
