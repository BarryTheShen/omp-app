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

/** The Context sections that hold a list field, with the field's title and the last line of its row. */
const LIST_SECTIONS = [
  {
    id: "P7.contextGeneral",
    tab: "General",
    field: "Additional Workspace Directories",
    lastLine: "One entry per line. Blank lines are ignored.",
  },
  {
    id: "P7.contextGeneral",
    tab: "General",
    field: "Extra Context Files",
    lastLine: "One entry per line. Blank lines are ignored.",
  },
  {
    id: "P7.contextCompaction",
    tab: "Compaction",
    field: "Compaction Method Order",
    lastLine: "Use omp's default order",
  },
  {
    id: "P7.contextRulesTtsr",
    tab: "Rules (TTSR)",
    field: "Disabled Rules",
    lastLine: "One entry per line. Blank lines are ignored.",
  },
] as const;

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
/** A 390 pixel phone at 200% browser zoom: the page lays out in a 195 CSS-pixel window. */
const PHONE_AT_200_PERCENT = { width: 195, height: 422 };

async function openContextTab(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Context", exact: true }).click();
  await expect(settings.getByRole("tab")).toHaveCount(4, { timeout: 30_000 });
  return settings;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("an element has no size on the page");
  return box;
}

/** A list row wider than the window makes the page scroll sideways; that is a layout bug at this width. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await waitForFiniteAnimations(page);
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
}

/**
 * The settings panel clips what overflows it, so the page can scroll nowhere and still cut a control off.
 * Each button, select and textarea of the card must sit inside the window.
 */
async function expectControlsInWindow(card: Locator, page: Page): Promise<void> {
  await waitForFiniteAnimations(page);
  const cut = await card.evaluate((element) => {
    const width = window.innerWidth;
    return [...element.querySelectorAll("button, select, textarea")]
      .map((control) => ({ control, box: control.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && (box.left < -0.5 || box.right > width + 0.5))
      .map(
        ({ control, box }) =>
          `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 30)}" left=${Math.round(box.left)} right=${Math.round(box.right)} window=${width}`,
      );
  });
  expect(cut).toEqual([]);
}

/** Scrolls the Compaction card so its list rows and Save changes are both in the frame. */
async function frameCompaction(settings: Locator, page: Page): Promise<void> {
  await settings
    .locator('[data-p7-context-section="P7.contextCompaction"]')
    .getByRole("button", { name: "Save changes", exact: true })
    .scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
}

realTest(
  "each Context list field sits inside its section's card, with Save changes and Cancel below it",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize(DESKTOP);
    const settings = await openContextTab(page);

    for (const { id, tab, field, lastLine } of LIST_SECTIONS) {
      await settings.getByRole("tab", { name: tab, exact: true }).click();
      const section = settings.locator(`[data-p7-context-section="${id}"]`);
      const card = section.getByRole("region", { name: tab, exact: true });
      const fieldTitle = card.getByText(field, { exact: true });
      const fieldRow = fieldTitle.locator("xpath=../..");
      const last = fieldRow.getByText(lastLine, { exact: true });
      const save = card.getByRole("button", { name: "Save changes", exact: true });
      const cancel = card.getByRole("button", { name: "Cancel", exact: true });
      await expect(fieldTitle).toBeVisible({ timeout: 30_000 });

      const cardBox = await boxOf(card);
      const titleBox = await boxOf(fieldTitle);
      const lastBox = await boxOf(last);
      const saveBox = await boxOf(save);
      const cancelBox = await boxOf(cancel);
      const cardBottom = cardBox.y + cardBox.height;
      const rowBottom = lastBox.y + lastBox.height;
      // The field's title and last line are inside the card; Save changes and Cancel are inside the
      // card and below the field's last line.
      expect(titleBox.y).toBeGreaterThan(cardBox.y);
      expect(rowBottom).toBeLessThanOrEqual(cardBottom);
      expect(saveBox.y).toBeGreaterThanOrEqual(rowBottom);
      expect(cancelBox.y).toBeGreaterThanOrEqual(rowBottom);
      expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(cardBottom);
      expect(cancelBox.y + cancelBox.height).toBeLessThanOrEqual(cardBottom);

      // With this section open: a phone width, and the same phone at 200% browser zoom. At both, the
      // page does not scroll sideways and no control of the card is cut off.
      await page.setViewportSize(PHONE);
      await expectNoSidewaysScroll(page);
      await expectControlsInWindow(card, page);
      await page.setViewportSize(PHONE_AT_200_PERCENT);
      await expectNoSidewaysScroll(page);
      await expectControlsInWindow(card, page);
      await page.setViewportSize(DESKTOP);
    }

    await mkdir(screenshots, { recursive: true });
    await settings.getByRole("tab", { name: "Compaction", exact: true }).click();
    await waitForFiniteAnimations(page);

    await page.setViewportSize(PHONE);
    await frameCompaction(settings, page);
    await page.screenshot({
      path: join(screenshots, "settings-context-lists-narrow.png"),
      fullPage: true,
    });

    await page.setViewportSize(PHONE_AT_200_PERCENT);
    await frameCompaction(settings, page);
    await page.screenshot({
      path: join(screenshots, "settings-context-lists-200pct.png"),
      fullPage: true,
    });

    await page.setViewportSize(DESKTOP);
    await frameCompaction(settings, page);
    await page.screenshot({
      path: join(screenshots, "settings-context-lists-light.png"),
      fullPage: true,
    });

    const dark = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await dark.setViewportSize(DESKTOP);
    const darkSettings = await openContextTab(dark);
    await darkSettings.getByRole("tab", { name: "Compaction", exact: true }).click();
    await frameCompaction(darkSettings, dark);
    await dark.screenshot({
      path: join(screenshots, "settings-context-lists-dark.png"),
      fullPage: true,
    });

    expect(realApp.problems).toEqual([]);
  },
);
