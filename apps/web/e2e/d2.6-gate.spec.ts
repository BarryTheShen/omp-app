import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #324 (D2.6), the keyboard, motion and width part of the CC6 gate for the composer's `/` list, run in the app with
 * real omp. The arrow keys move the highlight, Escape closes the list and keeps the typed text, the list starts no moving
 * animation under reduced motion, and it stays on the screen in dark mode and at 390 px. Touch is not run here: the
 * harness's pages have no touch context. The 200% zoom check is d2.3's, and the Enter that chooses a command is d2.3's.
 */

/** The list of omp's commands above the composer. */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** The option the arrow keys have highlighted: assistant-ui marks it with `data-highlighted`. */
function highlighted(page: Page): Locator {
  return commandList(page).locator("[data-highlighted]");
}

/** Runs in the page: counts the animations that are still running inside the command list, and last longer than a millisecond. */
function listMoving(): number {
  return document.getAnimations().filter((animation) => {
    if (animation.playState !== "running") return false;
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null;
    if (target === null || target.closest('[aria-label="Slash commands"]') === null) return false;
    const duration = Number(animation.effect?.getComputedTiming().duration);
    return Number.isNaN(duration) || duration > 1;
  }).length;
}

/** Waits until no finite animation is running, so the transitions a resize starts have ended before the page is measured or captured. */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getComputedTiming().iterations !== Infinity,
              ).length,
        ),
      { timeout: 10_000 },
    )
    .toBe(0);
}

realTest(
  "the arrow keys move the highlight in the / list, and Escape closes the list and keeps the typed text",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    // "/s" matches several of omp's commands; the list fills in once omp's catalog answers, so wait for the second option.
    await composer.fill("/s");
    const options = commandList(page).getByRole("option");
    await expect(options.nth(1)).toBeVisible({ timeout: 30_000 });
    const second = (await options.nth(1).innerText()).split(/\s+/u)[0] ?? "";
    expect(second.startsWith("/")).toBe(true);

    // The first option starts highlighted; ArrowDown moves the highlight to the next one, and ArrowUp moves it back.
    await expect(highlighted(page)).toHaveCount(1);
    await composer.press("ArrowDown");
    await expect(highlighted(page)).toContainText(second);
    await composer.press("ArrowUp");
    await expect(highlighted(page)).not.toContainText(second);

    // Escape closes the list and leaves the typed text as it was.
    await composer.press("Escape");
    await expect(commandList(page)).toBeHidden();
    await expect(composer).toHaveValue("/s");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "under reduced motion the / list starts no moving animation, and it reads in light mode",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ reducedMotion: "reduce" }),
    });
    const composer = await startChat(page);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );

    // The list can show its empty line for a moment while omp's catalog loads, so wait for a real option before measuring.
    await composer.fill("/s");
    await expect(commandList(page).getByRole("option").nth(1)).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    expect(await page.evaluate(listMoving)).toBe(0);

    // The list draws with the app's own surface, not the browser's default: a transparent background would mean no styles loaded.
    expect(
      await commandList(page)
        .locator("div.bg-popover")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe("rgba(0, 0, 0, 0)");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "d2.6-gate-light.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the / list reads in dark mode and stays on the screen at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    const composer = await startChat(page);
    await composer.fill("/s");
    await expect(commandList(page).getByRole("option").nth(1)).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(
      true,
    );
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "d2.6-gate-dark.png"), fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    const box = await commandList(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: join(screenshots, "d2.6-gate-narrow.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
