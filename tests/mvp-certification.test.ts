import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface EvidencePointer {
  path: string;
  testName: string;
}

const REQUIRED_SCENARIOS = [
  "Already-satisfied no-PR issue",
  "Investigation-only issue",
  "Planning-to-DAG issue",
  "One-PR docs/code issue",
  "Multi-PR issue",
  "Mechanical review failure",
  "Mechanical CI failure",
  "User-input/elicitation failure",
  "Crash/restart recovery",
  "Two-project registry daemon",
  "Application legibility proof",
  "Garbage-collection task"
];

const TEST_EVIDENCE: EvidencePointer[] = [
  {
    path: "tests/orchestrator.test.ts",
    testName: "records already-satisfied no-op handoffs without requiring a PR"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "records investigation-only implemented handoffs without requiring a PR"
  },
  {
    path: "tests/linear-planned-issues.test.ts",
    testName: "creates child and follow-up issues from plan input with inherited assignees and guardrail-friendly descriptions"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "skips Todo issues blocked by nonterminal dependencies"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "dispatches a child issue after its dependency reaches a terminal state"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "runs automated reviewers before moving an implemented PR to Human Review"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "persists multiple PR outputs without collapsing issue state to one PR"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "runs a focused fixer turn and recomputes review targets from the updated handoff"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "runs a bounded CI fixer turn for mechanical failed checks with logs"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "keeps using bounded CI fixer turns when the same check fails with different logs"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "stops denied MCP elicitation requests for human input without retrying"
  },
  {
    path: "tests/orchestrator.test.ts",
    testName: "rebuilds due retries from durable runtime state after restart"
  },
  {
    path: "tests/registry-orchestrator.test.ts",
    testName: "dispatches fairly across two fake projects under the global cap after restart"
  },
  {
    path: "tests/app-proof-scripts.test.ts",
    testName: "records configured proof commands without persisting secret-bearing command strings"
  },
  {
    path: "tests/maintenance.test.ts",
    testName: "seeds every template into the requested Linear project and state"
  },
  {
    path: "tests/maintenance.test.ts",
    testName: "exposes the top-level maintenance seed command"
  }
];

describe("MVP certification", () => {
  it("records every required MVP scenario in the release certification", async () => {
    const certification = await readFile("docs/releases/MVP.md", "utf8");
    expect(certification).toContain("Certification issue: VER-55");
    for (const scenario of REQUIRED_SCENARIOS) {
      expect(certification).toContain(`| ${scenario} | Covered |`);
    }
    for (const issue of ["VER-95", "VER-96", "VER-97", "VER-106", "VER-107", "VER-108", "VER-110", "VER-111", "VER-112"]) {
      expect(certification).toContain(issue);
    }
  });

  it("keeps MVP evidence pointers backed by real tests", async () => {
    for (const evidence of TEST_EVIDENCE) {
      const source = await readFile(evidence.path, "utf8");
      expect(source, `${evidence.path}: ${evidence.testName}`).toContain(`it("${evidence.testName}"`);
    }
  });

  it("keeps source-alignment scoring tied to the MVP certification", async () => {
    const audit = await readFile("docs/planning/SOURCE_ALIGNMENT_AUDIT.md", "utf8");
    expect(audit).toContain("docs/releases/MVP.md");
    expect(audit).toContain("Harness Engineering alignment: A-");
    expect(audit).toContain("Symphony alignment: A-");
  });
});
