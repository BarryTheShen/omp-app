import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RESCUE_AT_MOST_EVERY_MS, rescueIfServerAnswers } from "./linkRescue";

// The page's own reload helpers listen on `document`, which a test run has none of; the test passes its own reload.
vi.mock("./reloadKeepsChat", () => ({ reloadKeepingChat: vi.fn() }));

/** The page's storage and address, as the browser has them. */
beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => kept.set(key, value),
    removeItem: (key: string) => kept.delete(key),
  });
  vi.stubGlobal("window", { location: { pathname: "/" } });
});
afterEach(() => vi.unstubAllGlobals());

const answering = (ok: boolean) => vi.fn(async () => new Response("", { status: ok ? 200 : 502 }));

test("a stuck link reloads the page only while its server answers, and at most once in a while", async () => {
  let now = 1_000_000;
  const reload = vi.fn();
  // The server is down (or the device offline): no reload, a reload would not help.
  expect(
    await rescueIfServerAnswers("stuck", 20_000, {
      fetcher: answering(false),
      reload,
      now: () => now,
    }),
  ).toBe(false);
  expect(
    await rescueIfServerAnswers("stuck", 20_000, {
      fetcher: vi.fn(async () => {
        throw new TypeError("Load failed");
      }),
      reload,
      now: () => now,
    }),
  ).toBe(false);
  expect(reload).not.toHaveBeenCalled();
  // It answers while the link does not: the page's own connection is stuck.
  expect(
    await rescueIfServerAnswers("stuck", 20_000, {
      fetcher: answering(true),
      reload,
      now: () => now,
    }),
  ).toBe(true);
  expect(reload).toHaveBeenCalledTimes(1);
  // Stuck again soon after: no loop.
  now += RESCUE_AT_MOST_EVERY_MS - 1;
  expect(
    await rescueIfServerAnswers("stuck", 20_000, {
      fetcher: answering(true),
      reload,
      now: () => now,
    }),
  ).toBe(false);
  // The person's own Reconnect now still reloads.
  expect(
    await rescueIfServerAnswers("button", 6_000, {
      fetcher: answering(true),
      reload,
      now: () => now,
    }),
  ).toBe(true);
  now += RESCUE_AT_MOST_EVERY_MS;
  expect(
    await rescueIfServerAnswers("stuck", 20_000, {
      fetcher: answering(true),
      reload,
      now: () => now,
    }),
  ).toBe(true);
  expect(reload).toHaveBeenCalledTimes(3);
});
