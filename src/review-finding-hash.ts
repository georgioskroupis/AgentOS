import { createHash } from "node:crypto";
import type { ReviewFinding } from "./types.js";

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
