import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findingHash, readReviewArtifact, repeatedBlockingHashes, reviewArtifactPath, writeReviewArtifact } from "../src/review.js";
import type { ReviewFinding, ServiceConfig } from "../src/types.js";

const config = {
  review: {
    blockingSeverities: ["P0", "P1", "P2"]
  }
} as ServiceConfig;

describe("review artifacts", () => {
  it("normalizes finding hashes and persists reviewer artifacts", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-review-"));
    const path = reviewArtifactPath(repo, "AG-1", 1, "correctness");
    await writeReviewArtifact(path, {
      reviewer: "correctness",
      decision: "changes_requested",
      findings: [
        {
          reviewer: "correctness",
          decision: "changes_requested",
          severity: "P1",
          file: "src/orchestrator.ts",
          line: 10,
          body: "Fix the lifecycle regression.",
          findingHash: findingHash({
            reviewer: "correctness",
            decision: "changes_requested",
            severity: "P1",
            file: "src/orchestrator.ts",
            line: 10,
            body: "Fix the lifecycle regression."
          })
        }
      ]
    });

    expect(await readFile(path, "utf8")).toContain("correctness");
    const artifact = await readReviewArtifact(path, "correctness");
    expect(artifact.findings[0].findingHash).toHaveLength(16);
  });

  it("detects repeated blocking findings across iterations", () => {
    const finding: ReviewFinding = {
      reviewer: "tests",
      decision: "changes_requested",
      severity: "P2",
      file: "tests/orchestrator.test.ts",
      line: 1,
      body: "Missing regression coverage.",
      findingHash: "repeat"
    };

    expect(repeatedBlockingHashes([finding], [finding], config)).toEqual(["repeat"]);
  });
});
