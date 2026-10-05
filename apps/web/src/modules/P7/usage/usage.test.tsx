import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { UsagePort, UsageSnapshot } from "../contract";
import { UsagePopover } from "./usage-popover";

function usagePort(): UsagePort {
  const snapshot: UsageSnapshot = {
    sessionId: "usage-test",
    status: "ready",
    totals: {
      input: 100,
      output: 50,
      cacheRead: 25,
      cacheWrite: 25,
      totalTokens: 150,
      reasoning: 10,
      cost: 1.25,
      premiumRequests: 2,
    },
    contextUsage: { tokens: 200, contextWindow: 1_000, percent: 20 },
    tokenRate: 12,
    lastTurn: {
      timestamp: 1,
      durationMs: 1_000,
      timeToFirstTokenMs: 120,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 15,
        reasoning: null,
        cost: 0.1,
        premiumRequests: null,
      },
    },
    revision: "usage-test",
    error: null,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => snapshot,
  };
}

afterEach(cleanup);

describe("P7 usage popover", () => {
  test("shows session and per-turn token/cache/cost fields plus unavailable quota", () => {
    render(<UsagePopover port={usagePort()} />);
    fireEvent.click(screen.getByRole("button", { name: /Usage/ }));
    expect(screen.getAllByText("Cache hit")).toHaveLength(2);
    expect(screen.getByText("17%")).toBeTruthy();
    expect(screen.getByText("Provider quota is unavailable from this host.")).toBeTruthy();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.queryByText(/usage-test/)).toBeNull();
  });
});
