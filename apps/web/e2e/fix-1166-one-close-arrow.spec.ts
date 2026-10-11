import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

type Side = "sessions" | "panels";

/** Every control that closes a side panel: its own header arrow, named "Hide" (or "Collapse" before this fix). */
function closers(page: Page, side: Side): Locator {
  return page.getByRole("button", { name: new RegExp(`^(Hide|Collapse) ${side} sidebar$`) });
}

/** The control that opens a side panel while it is closed: the header arrow. */
function openers(page: Page, side: Side): Locator {
  return page.getByRole("button", { name: `Show ${side} sidebar`, exact: true });
}

/** Lets finite transitions settle before a screenshot. Bounded, so a transition that never ends cannot hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

/** One control closes the panel and it is named so; the opener is not on screen. */
async function expectOpen(page: Page, side: Side): Promise<void> {
  await expect(closers(page, side)).toHaveCount(1);
  await expect(closers(page, side)).toHaveAttribute("aria-label", `Hide ${side} sidebar`);
  await expect(openers(page, side)).toHaveCount(0);
}

/** One control opens the panel; no control closes it. */
async function expectClosed(page: Page, side: Side): Promise<void> {
  await expect(closers(page, side)).toHaveCount(0);
  await expect(openers(page, side)).toHaveCount(1);
}

realTest(
  "#1166: each side panel has one control that closes it while open and one that opens it while closed (1280, 1920 and 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(page.getByRole("navigation", { name: "Sessions" })).toBeAttached({
      timeout: 60_000,
    });
    const header = page.locator('[data-shell-region="header"]');

    for (const [width, height] of [
      [1280, 800],
      [1920, 1080],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const side of ["sessions", "panels"] as const) {
        // Open it, if it is closed: one control opens it, and then one control closes it.
        if ((await openers(page, side).count()) === 1) await openers(page, side).click();
        await expectOpen(page, side);
        await settle(page);
        await page.screenshot({ path: join(screenshots, `fix-1166-${width}-${side}-open.png`) });
        const headerBefore = await header.boundingBox();

        // Close it with its own arrow: one control opens it again.
        await closers(page, side).click();
        await expectClosed(page, side);
        await settle(page);
        await page.screenshot({ path: join(screenshots, `fix-1166-${width}-${side}-closed.png`) });
        const headerAfter = await header.boundingBox();
        // No other layout shift: the header keeps its height when one of its arrows changes.
        expect(headerAfter?.height).toBe(headerBefore?.height);
      }
    }
    // No other layout shift: with the Panels sidebar open, closing the sessions sidebar leaves the Panels sidebar where it was.
    await page.setViewportSize({ width: 1280, height: 800 });
    if ((await openers(page, "panels").count()) === 1) await openers(page, "panels").click();
    await expectOpen(page, "panels");
    if ((await openers(page, "sessions").count()) === 1) await openers(page, "sessions").click();
    await expectOpen(page, "sessions");
    const panelsRegion = page.getByRole("complementary", { name: "Panels" });
    const panelsBefore = await panelsRegion.boundingBox();
    await closers(page, "sessions").click();
    await expectClosed(page, "sessions");
    await settle(page);
    const panelsAfter = await panelsRegion.boundingBox();
    expect(panelsAfter?.x).toBe(panelsBefore?.x);
    expect(panelsAfter?.width).toBe(panelsBefore?.width);
    await openers(page, "sessions").click();
    await expectOpen(page, "sessions");

    // The keyboard shortcut still toggles the sessions panel at a desktop width.
    await page.setViewportSize({ width: 1280, height: 800 });
    if ((await openers(page, "sessions").count()) === 1) await openers(page, "sessions").click();
    await expectOpen(page, "sessions");
    await page.keyboard.press("Control+b");
    await expectClosed(page, "sessions");
    await page.keyboard.press("Control+b");
    await expectOpen(page, "sessions");
    expect(realApp.problems).toEqual([]);
  },
);
