import { describe, expect, test } from "vitest";
import type { OmpTurnUsage } from "@/modules/R0/runtime";
import { formatTurnUsage } from "../../parts/message-parts";

const usage: OmpTurnUsage = {
  input: 120,
  output: 30,
  cacheRead: 40,
  cacheWrite: 10,
};

describe("U1 assistant turn usage", () => {
  test("formats summed token counts, cache, first-token time and tokens per second", () => {
    expect(
      formatTurnUsage({
        usage,
        durationMs: 1_000,
        ttftMs: 250,
        timestamp: new Date(2026, 0, 2, 14, 5).getTime(),
      }),
    ).toEqual(["14:05", "in 130", "out 30", "cache 40", "first token 0.3s", "30.0 tokens/s"]);
  });

  test("omits a missing first-token time while retaining throughput", () => {
    expect(
      formatTurnUsage({ usage, durationMs: 200, ttftMs: undefined, timestamp: undefined }),
    ).toEqual(["in 130", "out 30", "cache 40", "150.0 tokens/s"]);
  });

  test("omits throughput at 100 ms and when output tokens are zero", () => {
    expect(
      formatTurnUsage({ usage, durationMs: 100, ttftMs: undefined, timestamp: undefined }),
    ).toEqual(["in 130", "out 30", "cache 40"]);
    expect(
      formatTurnUsage({ usage, durationMs: 101, ttftMs: undefined, timestamp: undefined }),
    ).toEqual(["in 130", "out 30", "cache 40", "297.0 tokens/s"]);
    expect(
      formatTurnUsage({
        usage: { ...usage, output: 0 },
        durationMs: 500,
        ttftMs: undefined,
        timestamp: undefined,
      }),
    ).toEqual(["in 130", "out 0", "cache 40"]);
  });

  test("returns no summary when omp supplies no token usage", () => {
    expect(
      formatTurnUsage({
        usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        durationMs: 0,
        ttftMs: undefined,
        timestamp: undefined,
      }),
    ).toBeNull();
    expect(
      formatTurnUsage({
        usage: undefined,
        durationMs: undefined,
        ttftMs: undefined,
        timestamp: undefined,
      }),
    ).toBeNull();
  });
});
