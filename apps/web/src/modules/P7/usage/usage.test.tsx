import type { UsageLimitsResult } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { UsageLimitsSource, UsagePort, UsageSnapshot } from "../contract";
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

function limitsSource(result: UsageLimitsResult): UsageLimitsSource {
  return { read: async () => result };
}

const readyLimits: UsageLimitsResult = {
  state: "ready",
  fetchedAt: "2026-10-10T04:00:00.000Z",
  providers: [
    {
      providerId: "anthropic",
      windows: [
        { label: "5 Hour", usedPercent: 41, resetsAt: "2026-10-10T08:30:00.000Z", accounts: 1 },
        { label: "7 Day", usedPercent: 72.4, resetsAt: null, accounts: 2 },
      ],
    },
  ],
};

afterEach(cleanup);

describe("P7 usage popover", () => {
  test("shows session and per-turn token/cache/cost fields plus each provider window's share and reset", async () => {
    render(<UsagePopover limits={limitsSource(readyLimits)} port={usagePort()} />);
    fireEvent.click(screen.getByRole("button", { name: /Usage/ }));
    expect(screen.getAllByText("Cache hit")).toHaveLength(2);
    expect(screen.getByText("17%")).toBeTruthy();
    expect(screen.getByText("$1.25")).toBeTruthy();
    expect(screen.queryByText(/usage-test/)).toBeNull();
    const fiveHour = await screen.findByRole("progressbar", { name: "anthropic, 5 hour limit" });
    expect(fiveHour.getAttribute("aria-valuenow")).toBe("41");
    expect(fiveHour.getAttribute("aria-valuetext")).toMatch(/^41% used, resets (in .+|now)$/);
    const sevenDay = screen.getByRole("progressbar", { name: "anthropic, 7 day limit" });
    expect(sevenDay.getAttribute("aria-valuenow")).toBe("72");
    expect(sevenDay.getAttribute("aria-valuetext")).toBe("72% used, reset time unknown");
    expect(screen.getByText(/\(the fullest of 2 accounts\)/)).toBeTruthy();
  });

  test("says why omp's limits cannot be read, in omp's own plain reason", async () => {
    render(
      <UsagePopover
        limits={limitsSource({
          state: "unavailable",
          reason: "omp did not report provider limits within 45 seconds.",
        })}
        port={usagePort()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Usage/ }));
    expect(
      await screen.findByText("omp did not report provider limits within 45 seconds."),
    ).toBeTruthy();
  });

  test("says when omp reports no limits for the signed-in accounts", async () => {
    render(
      <UsagePopover
        limits={limitsSource({
          state: "ready",
          fetchedAt: "2026-10-10T04:00:00.000Z",
          providers: [],
        })}
        port={usagePort()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Usage/ }));
    expect(
      await screen.findByText("omp reports no usage limits for your signed-in accounts."),
    ).toBeTruthy();
  });
});
