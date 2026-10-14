import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const IMPORT_TITLE = "Import a shared chat";
const UNAVAILABLE_REASON =
  "omp can't import shared chats in this version. Importing needs a newer version of omp.";
const LINK_PLACEHOLDER = "Paste the share link, which starts with https://";
const CONFIRM_TITLE = "Import this shared chat?";

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

/** Opens the command palette, searches for the import command, and returns its row. */
async function openImportRow(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("import");
  return page.getByRole("option", { name: IMPORT_TITLE });
}

realTest(
  "#387: while omp cannot import, the palette lists the import as unavailable with its reason, and asks nothing",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await startChat(page);
    const row = await openImportRow(page);
    await expect(row).toBeVisible();
    await expect(row).toBeDisabled();
    await expect(page.getByText(UNAVAILABLE_REASON, { exact: true })).toBeVisible();
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "d4-5-import-palette-light.png") });
    // A disabled row ignores the click: neither the link question nor Confirm opens.
    await row.click({ force: true });
    await expect(page.getByPlaceholder(LINK_PLACEHOLDER)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: CONFIRM_TITLE })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#387: the unavailable import reads in dark and at 390 px, with no overflow",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const row = await openImportRow(page);
    await expect(row).toBeDisabled();
    await expect(page.getByText(UNAVAILABLE_REASON, { exact: true })).toBeVisible();
    await expectStylesLoaded(page);
    await expectNoHorizontalOverflow(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "d4-5-import-palette-narrow-dark.png") });
    expect(realApp.problems).toEqual([]);
  },
);
