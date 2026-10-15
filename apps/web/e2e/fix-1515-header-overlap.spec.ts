import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * #1515: the header's controls do not draw over each other at any width. At 195 px (a 390 px phone at 200% zoom) the
 * model chip sat under the Settings button, and the right drawer's arrow sat over Settings. Real omp, fake model.
 */

/** What the page reports about the header's reachable controls: which are clipped, overlap or cross the window's edge. */
interface HeaderReport {
  readonly clipped: readonly string[];
  readonly overlapping: readonly (readonly [string, string])[];
  readonly crossingEdge: readonly string[];
}

/** Lets the narrow layout's transitions start and finish, then waits for every finite animation to end. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
  await waitForFiniteAnimations(page);
}

/** Measures the buttons in the top band of the page that a person can reach: not hidden, inert or aria-hidden. */
function measureHeader(page: Page): Promise<HeaderReport> {
  return page.evaluate(() => {
    const label = (element: HTMLElement): string =>
      (element.textContent ?? "").trim() || element.getAttribute("aria-label") || element.tagName;
    const reachable = (element: HTMLElement): boolean => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || box.top >= 80) return false;
      if (element.closest("[inert], [aria-hidden='true']") !== null) return false;
      return getComputedStyle(element).visibility !== "hidden";
    };
    const items = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
      reachable,
    );
    const clipped = items
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => label(element));
    const overlapping: [string, string][] = [];
    items.forEach((first, index) => {
      for (const second of items.slice(index + 1)) {
        if (first.contains(second) || second.contains(first)) continue;
        const a = first.getBoundingClientRect();
        const b = second.getBoundingClientRect();
        if (
          a.left < b.right - 0.5 &&
          b.left < a.right - 0.5 &&
          a.top < b.bottom - 0.5 &&
          b.top < a.bottom - 0.5
        ) {
          overlapping.push([label(first), label(second)]);
        }
      }
    });
    const crossingEdge = items
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.left < window.innerWidth && box.right > window.innerWidth + 0.5;
      })
      .map((element) => label(element));
    return { clipped, overlapping, crossingEdge };
  });
}

const WIDTHS = [
  { width: 195, name: "195 px (a 390 px phone at 200% zoom)" },
  { width: 320, name: "320 px" },
  { width: 390, name: "390 px" },
  { width: 1280, name: "1280 px" },
] as const;

for (const { width, name } of WIDTHS) {
  realTest(
    `at ${name}, the header's controls do not overlap, clip or cross the window's edge`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      const page = await realApp.open();
      await startChat(page);
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await settle(page);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({ path: join(screenshots, `fix-1515-header-${width}-light.png`) });
      expect(await measureHeader(page)).toEqual({ clipped: [], overlapping: [], crossingEdge: [] });
    },
  );
}
