import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 1332: the Panels sidebar's resize grip sat on the window's right edge, because both grips used the end edge,
 * while the Panels sidebar draws its border on its start side. The grip was also 1 px tall (preflight gives an hr a
 * zero height), so a pointer could grab it only at the top edge. The grip now sits on the inner border and spans the
 * sidebar's height: a drag from the border widens the sidebar, and ArrowLeft does the same from the keyboard. At
 * 390 px the sidebars are drawers and have no grip. Captured in light, dark and at 390 px.
 */

const GRIP = /Resize panels sidebar/;

/** Lets finite transitions settle before a measurement or a screenshot. Bounded, so a stuck transition cannot hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("The element has no box to measure.");
  return box;
}

realTest(
  "#1332: the Panels resize grip sits on the sidebar's inner border, widens the sidebar when dragged there, and is absent at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const panels = page.getByRole("complementary", { name: "Panels" });
    const grip = page.getByRole("separator", { name: GRIP });
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute("data-open", "true");
    await expect(grip).toBeVisible();
    await settle(page);

    // The grip starts on the sidebar's inner border (its start edge), inside the 1 px border, and spans its full height.
    const sidebar = await boxOf(panels);
    const handle = await boxOf(grip);
    expect
      .soft(handle.x - sidebar.x, "the grip starts at the Panels sidebar's inner border")
      .toBeGreaterThanOrEqual(0);
    expect
      .soft(handle.x - sidebar.x, "the grip starts at the Panels sidebar's inner border")
      .toBeLessThanOrEqual(2);
    expect
      .soft(handle.height, "the grip spans the Panels sidebar's full height")
      .toBeGreaterThanOrEqual(sidebar.height - 1);

    // A pointer drag that starts on the border line widens the sidebar.
    const borderX = sidebar.x + 2;
    const midY = sidebar.y + sidebar.height / 2;
    await page.mouse.move(borderX, midY);
    await page.mouse.down();
    // The Panels sidebar is capped at 24vw (307 px at 1280 px), so this drag is a short one.
    await page.mouse.move(borderX - 12, midY, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => (await boxOf(panels)).width, {
        message: "the drag from the border widens the sidebar",
      })
      .toBeGreaterThan(sidebar.width + 6);

    // The keyboard does the same: ArrowLeft widens the right panel by one rem.
    await grip.focus();
    const widened = Number(await grip.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowLeft");
    await expect(grip).toHaveAttribute("aria-valuenow", String(widened + 1));
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1332-light.png") });

    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1332-dark.png") });

    // At 390 px the sidebars are drawers: there is no grip to resize them.
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await page.getByRole("button", { name: "Show Panels sidebar" }).click();
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute("data-open", "true");
    await expect(grip).toHaveCount(0);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1332-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);
