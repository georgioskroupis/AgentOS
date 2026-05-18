import { describe, expect, it } from "vitest";
import { detectCapacityWait } from "../src/capacity-wait.js";

describe("capacity wait detection", () => {
  it("parses Codex usage-limit reset messages with an English date", () => {
    const now = new Date(2026, 4, 17, 23, 17, 13);
    const wait = detectCapacityWait(
      "Error running remote compact task: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 18th, 2026 1:30 AM.",
      now
    );

    const expected = new Date(2026, 4, 18, 1, 30, 0);
    expect(wait).toMatchObject({
      resetAt: expected.toISOString(),
      delayMs: expected.getTime() - now.getTime(),
      reason: "codex usage capacity reset time was provided"
    });
  });

  it("parses ISO reset times without treating unrelated errors as capacity waits", () => {
    expect(detectCapacityWait("usage limit reached; try again after 2026-05-18T01:30:00Z", new Date("2026-05-17T20:17:13Z"))?.resetAt).toBe("2026-05-18T01:30:00.000Z");
    expect(detectCapacityWait("TypeScript compilation failed at src/index.ts:10", new Date("2026-05-17T20:17:13Z"))).toBeNull();
  });
});
