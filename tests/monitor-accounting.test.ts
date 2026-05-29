import { describe, expect, it } from "vitest";
import { absoluteThreadTokenTotalsFromMessage } from "../src/monitor-accounting.js";

describe("monitor token accounting", () => {
  it("prefers absolute thread totals when they are available", () => {
    expect(
      absoluteThreadTokenTotalsFromMessage({
        params: {
          tokenUsage: {
            total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            delta: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
          },
          usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 }
        }
      })
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("does not treat delta-style payloads or ambiguous usage maps as cumulative totals", () => {
    expect(
      absoluteThreadTokenTotalsFromMessage({
        params: {
          tokenUsage: { delta: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        }
      })
    ).toBeNull();

    expect(
      absoluteThreadTokenTotalsFromMessage({
        params: {
          tokenUsage: { type: "delta", inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        }
      })
    ).toBeNull();
  });

  it("accepts explicitly cumulative direct tokenUsage maps", () => {
    expect(
      absoluteThreadTokenTotalsFromMessage({
        params: {
          tokenUsage: { scope: "thread", input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
      })
    ).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });
});
