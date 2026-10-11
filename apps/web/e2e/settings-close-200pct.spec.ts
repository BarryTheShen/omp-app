import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

const PHONE = { width: 390, height: 844 };
/** A 390 pixel phone at 200% browser zoom: the page lays out in a 195 CSS-pixel window. */
const PHONE_AT_200_PERCENT = { width: 195, height: 422 };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("an element has no size on the page");
  return box;
}

function expectInside(inner: Box, outer: Box): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await waitForFiniteAnimations(page);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
}

/**
 * The header's Close button is the last thing a phone user needs at 200% zoom. It must sit inside the
 * dialog and the dialog inside the window, and the title shortens instead of pushing Close out.
 */
async function expectCloseInWindow(
  page: Page,
  settings: Locator,
  size: { width: number; height: number },
) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  const close = settings.getByRole("button", { name: "Close settings", exact: true });
  await expect(close).toBeVisible();
  await waitForFiniteAnimations(page);
  const dialogBox = await boxOf(dialog);
  expectInside(await boxOf(close), dialogBox);
  expectInside(dialogBox, { x: 0, y: 0, width: size.width, height: size.height });
  await expectNoSidewaysScroll(page);
}

for (const scheme of ["light", "dark"] as const) {
  realTest(
    `the Settings Close button stays inside the dialog on a phone at 200% zoom, in ${scheme} theme`,
    async ({ realApp }) => {
      const page = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(
            (theme: string) => window.localStorage.setItem("omp-app.theme", theme),
            scheme,
          ),
      });
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.setViewportSize(PHONE_AT_200_PERCENT);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByTestId("settings-screen");
      await expect(settings).toBeVisible();
      await expectCloseInWindow(page, settings, PHONE_AT_200_PERCENT);

      await mkdir(screenshots, { recursive: true });
      const header = settings.locator("header").first();
      await page.screenshot({
        path: join(screenshots, `settings-close-200pct-${scheme}.png`),
        clip: await boxOf(header),
      });

      await page.setViewportSize(PHONE);
      await expectCloseInWindow(page, settings, PHONE);
      await page.screenshot({
        path: join(screenshots, `settings-close-390-${scheme}.png`),
        clip: await boxOf(settings.locator("header").first()),
      });
    },
  );
}
