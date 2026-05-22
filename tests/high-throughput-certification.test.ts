import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface CertificationEvidence {
  path: string;
  testName: string;
}

interface CertificationScenario {
  id: string;
  status: string;
  evidence: CertificationEvidence[];
}

interface HighThroughputCertification {
  schemaVersion: number;
  parentIssue: string;
  certificationIssue: string;
  status: string;
  childIssues: Array<{ id: string; requiredForCertification: boolean }>;
  scenarios: CertificationScenario[];
  knownRemainingDeviations: string[];
  nonMvpFutureWork: string[];
}

const REQUIRED_SCENARIOS = [
  "landing-gates-pass",
  "ci-diagnostics-mechanical-flaky-ambiguous",
  "approval-and-supervisor-evidence-refresh",
  "draft-pr-ready-when-configured",
  "selected-target-only",
  "post-merge-cleanup",
  "default-public-template-stays-conservative",
  "protected-branch-and-merge-queue-report-only"
];

describe("high-throughput landing certification", () => {
  it("maps VER-54 certification to concrete scenario evidence", async () => {
    const certification = await readCertification();
    expect(certification).toMatchObject({
      schemaVersion: 1,
      parentIssue: "VER-54",
      certificationIssue: "VER-87",
      status: "certified"
    });
    expect(certification.childIssues.filter((issue) => issue.requiredForCertification).map((issue) => issue.id)).toEqual([
      "VER-83",
      "VER-84",
      "VER-85",
      "VER-86",
      "VER-87"
    ]);
    expect(certification.scenarios.map((scenario) => scenario.id)).toEqual(REQUIRED_SCENARIOS);
    expect(certification.knownRemainingDeviations.length).toBeGreaterThan(0);
    expect(certification.nonMvpFutureWork.length).toBeGreaterThan(0);
  });

  it("keeps every certification evidence pointer backed by a real test", async () => {
    const certification = await readCertification();
    for (const scenario of certification.scenarios) {
      expect(scenario.status, scenario.id).toBe("covered");
      expect(scenario.evidence.length, scenario.id).toBeGreaterThan(0);
      for (const evidence of scenario.evidence) {
        const source = await readFile(evidence.path, "utf8");
        expect(source, `${scenario.id}: ${evidence.path}`).toContain(`it("${evidence.testName}"`);
      }
    }
  });
});

async function readCertification(): Promise<HighThroughputCertification> {
  return JSON.parse(await readFile("docs/releases/high-throughput-landing-certification.json", "utf8")) as HighThroughputCertification;
}
