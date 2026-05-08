import { describe, expect, it } from "vitest";
import { buildTargetedContextPack } from "../src/context-pack.js";
import type { CheckDiagnostic, PullRequestStatus } from "../src/github.js";
import type { Issue, IssueState, ReviewFinding } from "../src/types.js";

const issue: Issue = {
  id: "issue-1",
  identifier: "AG-1",
  title: "Build targeted context packs",
  description: "Acceptance criteria: keep required issue text and bounded evidence.",
  priority: 1,
  state: "In Progress",
  branch_name: "agent/AG-1",
  url: "https://linear.app/example/issue/AG-1",
  assignee: "Supervisor",
  labels: ["orchestration"],
  blocked_by: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z"
};

describe("targeted context packs", () => {
  it("keeps implementation re-entry focused on authoritative decisions and validation summaries", () => {
    const state: IssueState = {
      schemaVersion: 1,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      updatedAt: "2026-01-02T00:00:00.000Z",
      humanDecisions: [
        {
          type: "fix_findings",
          decidedAt: "2026-01-02T00:00:00.000Z",
          source: "linear-comment",
          actor: "Supervisor",
          commentId: "comment-1",
          body: "HISTORIC_TRANSCRIPT_SHOULD_NOT_APPEAR",
          prHeadSha: "abc123",
          validationEvidence: ".agent-os/validation/AG-1.json",
          ciState: "pending",
          findings: "open",
          summary: "fix the reviewer notes"
        }
      ],
      validation: {
        status: "passed",
        finalStatus: "passed",
        checkedAt: "2026-01-02T00:01:00.000Z",
        path: ".agent-os/validation/AG-1.json",
        acceptedCommands: [{ name: "npm run agent-check", exitCode: 0, startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:01:00.000Z" }]
      }
    };

    const pack = buildTargetedContextPack({
      kind: "implementation-reentry",
      issue,
      state,
      runId: "run_20260102_AG-1_context"
    });

    expect(pack).toContain("Pack kind: implementation-reentry");
    expect(pack).toContain("Acceptance criteria: keep required issue text");
    expect(pack).toContain("fix_findings");
    expect(pack).toContain("PR head SHA: abc123");
    expect(pack).toContain("npm run agent-check");
    expect(pack).toContain(".agent-os/runs/run_20260102_AG-1_context/events.jsonl");
    expect(pack).not.toContain("HISTORIC_TRANSCRIPT_SHOULD_NOT_APPEAR");
  });

  it("bounds reviewer diff context and points to the full PR diff reference", () => {
    const longDiff = `diff --git a/src/context.ts b/src/context.ts\n+REQUIRED_DIFF_SENTINEL\n${"x".repeat(20_000)}\n+IRRELEVANT_HISTORIC_OUTPUT`;
    const pack = buildTargetedContextPack({
      kind: "reviewer",
      issue,
      pullRequests: [
        {
          target: { url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: "2026-01-02T00:00:00.000Z" },
          status: prStatus({ changedFiles: ["src/context.ts"] }),
          diff: longDiff,
          threads: []
        }
      ],
      reviewer: "correctness",
      iteration: 1
    });

    expect(pack).toContain("Pack kind: reviewer");
    expect(pack).toContain("REQUIRED_DIFF_SENTINEL");
    expect(pack).toContain("Full PR diff: gh pr diff https://github.com/o/r/pull/1");
    expect(pack).toContain("[truncated; full context reference: gh pr diff https://github.com/o/r/pull/1]");
    expect(pack).not.toContain("IRRELEVANT_HISTORIC_OUTPUT");
  });

  it("keeps fixer findings available without carrying unrelated historic output", () => {
    const findings: ReviewFinding[] = [
      {
        reviewer: "architecture",
        decision: "changes_requested",
        severity: "P1",
        file: "src/orchestrator.ts",
        line: 42,
        body: `Keep this actionable finding. ${"x".repeat(5_000)} IRRELEVANT_HISTORIC_OUTPUT`,
        findingHash: "finding-1"
      }
    ];

    const pack = buildTargetedContextPack({ kind: "fixer", issue, findings });

    expect(pack).toContain("Pack kind: fixer");
    expect(pack).toContain("Keep this actionable finding.");
    expect(pack).toContain("[truncated; full context reference: review artifact finding]");
    expect(pack).not.toContain("IRRELEVANT_HISTORIC_OUTPUT");
  });

  it("includes sanitized bounded CI repair excerpts", () => {
    const secret = `ghp_${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const diagnostics: CheckDiagnostic[] = [
      {
        check: { name: "AgentOS CI", status: "COMPLETED", conclusion: "FAILURE", url: "https://github.com/o/r/actions/runs/123" },
        classification: "mechanical",
        reason: "TypeScript compilation failed",
        log: `npm run agent-check\nTOKEN=${secret}\nsrc/orchestrator.ts(12,3): error TS2304: Cannot find name 'missingValue'.\n${"x".repeat(5_000)}`
      }
    ];

    const pack = buildTargetedContextPack({
      kind: "ci-repair",
      issue,
      pullRequests: [
        {
          target: { url: "https://github.com/o/r/pull/1", source: "handoff", role: "primary", discoveredAt: "2026-01-02T00:00:00.000Z" },
          status: prStatus({ checkSummary: { total: 1, successful: 0, pending: 0, failing: 1 } }),
          checkDiagnostics: diagnostics
        }
      ],
      findings: [
        {
          reviewer: "checks",
          decision: "changes_requested",
          severity: "P1",
          file: null,
          line: null,
          body: "AgentOS CI failed mechanically with logs available.",
          findingHash: "checks-1"
        }
      ]
    });

    expect(pack).toContain("Pack kind: ci-repair");
    expect(pack).toContain("AgentOS CI");
    expect(pack).toContain("TS2304");
    expect(pack).toContain("[REDACTED]");
    expect(pack).not.toContain(secret);
    expect(pack.length).toBeLessThan(8_000);
  });
});

function prStatus(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    url: "https://github.com/o/r/pull/1",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    baseRefName: "main",
    headRefName: "agent/AG-1",
    headRepository: { owner: "o", repo: "r" },
    isCrossRepository: false,
    headSha: "abc123",
    merged: false,
    checkSummary: { total: 1, successful: 1, pending: 0, failing: 0 },
    checkDetails: [{ name: "AgentOS CI", status: "COMPLETED", conclusion: "SUCCESS", url: "https://github.com/o/r/actions/runs/123" }],
    changedFiles: ["src/orchestrator.ts"],
    reviewDecision: null,
    latestReviews: [],
    comments: [],
    ...overrides
  };
}
