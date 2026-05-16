import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findingHash,
  readReviewArtifact,
  readReviewArtifactResult,
  repeatedBlockingHashes,
  reviewArtifactPath,
  reviewArtifactSnapshot,
  writeReviewArtifact
} from "../src/review.js";
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

    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.schemaVersion).toBe(1);
    expect(raw.reviewer).toBe("correctness");
    const artifact = await readReviewArtifact(path, "correctness");
    expect(artifact.schemaVersion).toBe(1);
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

  it("treats malformed or mismatched artifacts as human_required", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-review-malformed-"));
    const invalidJsonPath = reviewArtifactPath(repo, "AG-1", 1, "self");
    await mkdir(dirname(invalidJsonPath), { recursive: true });
    await writeFile(invalidJsonPath, "{not-json", "utf8");

    await expect(readReviewArtifact(invalidJsonPath, "self")).resolves.toMatchObject({
      reviewer: "self",
      decision: "human_required",
      findings: [expect.objectContaining({ body: expect.stringContaining("invalid review JSON") })]
    });

    const mismatchedPath = reviewArtifactPath(repo, "AG-1", 1, "tests");
    await writeFile(
      mismatchedPath,
      JSON.stringify({
        schemaVersion: 1,
        reviewer: "architecture",
        decision: "approved",
        findings: []
      }),
      "utf8"
    );

    await expect(readReviewArtifact(mismatchedPath, "tests")).resolves.toMatchObject({
      reviewer: "tests",
      decision: "human_required",
      findings: [expect.objectContaining({ body: expect.stringContaining("reviewer=architecture") })]
    });
  });

  it("detects stale artifacts by pre-attempt snapshot instead of wall-clock timestamp", async () => {
    const repo = await mkdtemp(join(tmpdir(), "agent-os-review-stale-"));
    const path = reviewArtifactPath(repo, "AG-1", 1, "self");
    await writeReviewArtifact(path, {
      reviewer: "self",
      decision: "approved",
      findings: []
    });
    const previous = await reviewArtifactSnapshot(path);

    await expect(readReviewArtifactResult(path, "self", { staleIfUnchangedFrom: previous })).resolves.toMatchObject({
      ok: false,
      failure: { kind: "stale_artifact" }
    });

    await writeReviewArtifact(path, {
      reviewer: "self",
      decision: "changes_requested",
      findings: [
        {
          reviewer: "self",
          decision: "changes_requested",
          severity: "P2",
          file: "src/reviewer-runner.ts",
          line: 1,
          body: "Fresh finding.",
          findingHash: "fresh"
        }
      ]
    });

    await expect(readReviewArtifactResult(path, "self", { staleIfUnchangedFrom: previous })).resolves.toMatchObject({
      ok: true,
      artifact: { decision: "changes_requested" }
    });
  });
});
