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

const TABS = [
  "Appearance",
  "Interaction",
  "Model",
  "Context",
  "Files",
  "Shell",
  "Tools",
  "Tasks",
  "Providers",
] as const;

/**
 * The tall desktop window from the report (1491 x 1698), a short laptop window (1280 x 600) where every
 * tab is taller than the dialog, and a phone (390 x 844).
 */
const SIZES = [
  { label: "tall", width: 1491, height: 1698 },
  { label: "short", width: 1280, height: 600 },
  { label: "phone", width: 390, height: 844 },
] as const;

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("an element has no size on the page");
  return box;
}

function expectInside(inner: Box, outer: Box, slack = 0): void {
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - slack);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y - slack);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + slack);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + slack);
}

/** A page wider than the window scrolls sideways; that is a layout bug at every size. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await waitForFiniteAnimations(page);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  return settings;
}

/** Selects a Settings tab and waits until its panel has loaded. */
async function selectTab(settings: Locator, tab: string): Promise<void> {
  await settings.getByRole("button", { name: tab, exact: true }).click();
  await expect(settings.getByText(/^Loading /)).toHaveCount(0, { timeout: 30_000 });
}

/**
 * The panel's body is the one scroll container inside the dialog. When a tab is taller than the dialog,
 * the wheel and Page Down move the body, and its last enabled button can be scrolled into view and clicked.
 * The Close button stays inside the dialog throughout.
 */
async function checkTab(
  page: Page,
  settings: Locator,
  tab: string,
  capture?: string,
): Promise<void> {
  await selectTab(settings, tab);
  await waitForFiniteAnimations(page);
  // The first body is the Settings panel's own; a tab can hold a nested panel with a body of its own.
  const body = settings.locator('[data-panel-scroll="body"]').first();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  const close = settings.getByRole("button", { name: "Close settings", exact: true });

  // The panel and the dialog share the 80dvh cap, but the dialog's 1px border sits inside that cap: the
  // body can run 1px past the dialog's edge, under the border. Its bottom padding is what is clipped.
  expectInside(await boxOf(body), await boxOf(dialog), 2);
  const overflows = await body.evaluate((element) => element.scrollHeight > element.clientHeight);
  if (overflows) {
    // Near the body's top corner, on the tab's own content: a nested panel (Tools has one) scrolls itself under the
    // pointer, as it should, and the window's middle can fall on it.
    await body.hover({ position: { x: 8, y: 8 } });
    await page.mouse.wheel(0, 600);
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await body.getByRole("button").filter({ visible: true }).first().focus();
    await page.keyboard.press("PageDown");
    await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  }

  const last = body.getByRole("button", { disabled: false }).filter({ visible: true }).last();
  await last.scrollIntoViewIfNeeded();
  expectInside(await boxOf(last), await boxOf(body));
  await last.click();
  await waitForFiniteAnimations(page);

  expectInside(await boxOf(close), await boxOf(dialog));
  await expectNoSidewaysScroll(page);
  if (capture) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, `${capture}.png`) });
  }
}

for (const size of SIZES) {
  realTest(
    `every Settings tab scrolls to its last control at the ${size.label} window size`,
    async ({ realApp }) => {
      const page = await realApp.open();
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.setViewportSize({ width: size.width, height: size.height });
      const settings = await openSettings(page);
      for (const tab of TABS) {
        const capture =
          size.label === "short" && tab === "Context" ? "settings-scroll-short-context" : undefined;
        await checkTab(page, settings, tab, capture);
      }
    },
  );
}
