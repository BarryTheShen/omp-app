import type { AppClient } from "@omp-app/client";
import { AppFailure } from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { keepShareLink } from "./link";

const ended = () =>
  Promise.reject(
    new AppFailure({ code: "not_found", message: "That share has ended.", retryable: false }),
  );
const lost = () =>
  Promise.reject(new AppFailure({ code: "unavailable", message: "No answer.", retryable: true }));

/** An app client whose shares port answers `open` with each answer in turn, the last one again after that. */
function client(answers: readonly (() => Promise<{ url: string }>)[]) {
  let asked = 0;
  const fake = {
    port: () => ({
      open: () => {
        const answer = answers[Math.min(asked, answers.length - 1)];
        asked += 1;
        return answer?.() ?? ended();
      },
    }),
  } as unknown as AppClient;
  return { fake, asked: () => asked };
}

describe("a share's link kept ready (#2788, #2836)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("a share that ended says so once, for good, and is not asked for again", async () => {
    const { fake, asked } = client([async () => ({ url: "https://a/1" }), ended]);
    const seen: [string | null, boolean][] = [];
    const link = keepShareLink(fake, "s1", (url, gone) => seen.push([url, gone]));
    await vi.advanceTimersByTimeAsync(0);
    link.refresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    link.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      ["https://a/1", false],
      [null, true],
    ]);
    expect(asked()).toBe(2);
  });

  test("a link that could not be made is not an ended share: it is asked for again", async () => {
    const { fake, asked } = client([lost, async () => ({ url: "https://a/2" })]);
    const seen: [string | null, boolean][] = [];
    keepShareLink(fake, "s1", (url, gone) => seen.push([url, gone]));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(seen).toEqual([
      [null, false],
      ["https://a/2", false],
    ]);
    expect(asked()).toBe(2);
  });
});
