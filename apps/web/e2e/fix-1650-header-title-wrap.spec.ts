import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const CHAT_TITLE =
  "Investigating why the extension center needs clearer duplicate plugin versions for every project workspace today";
const VIEWPORTS = [195, 320, 390, 834, 1280] as const;

realTest.use({ seedSessions: 12 });

function sessionRow(page: Page, title: string) {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(title) });
}

realTest(
  "the chat title stays visible and does not overlap header controls across widths",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const originalTitle = "Seeded chat 11";
    await sessionRow(page, originalTitle).hover();
    await page.getByRole("button", { name: `More actions for ${originalTitle}` }).click();
    await page
      .getByRole("menu", { name: `Actions for ${originalTitle}` })
      .getByRole("menuitem", { name: `Rename ${originalTitle}` })
      .click();
    const rename = page.getByRole("textbox", { name: `Rename ${originalTitle}` });
    await rename.fill(CHAT_TITLE);
    await rename.press("Enter");
    const row = sessionRow(page, CHAT_TITLE);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const title = page.locator('[data-layout-area="header"] [data-surface="title"] h1');
    await expect(title).toHaveText(CHAT_TITLE, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: CHAT_TITLE })).toBeVisible();
    const model = page.locator('[data-layout-area="composerToolbar"] [data-surface="model"]');
    await expect(model).toBeVisible();
    await mkdir(screenshots, { recursive: true });

    for (const width of VIEWPORTS) {
      for (const dark of [false, true]) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(
          (isDark) => document.documentElement.classList.toggle("dark", isDark),
          dark,
        );
        await waitForFiniteAnimations(page);
        const boxes = await page.evaluate(() => {
          const header = document.querySelector<HTMLElement>('[data-shell-region="header"]');
          const title = document.querySelector<HTMLElement>(
            '[data-layout-area="header"] [data-surface="title"] h1',
          );
          const settings = document.querySelector<HTMLElement>(
            '[data-layout-area="header"] [data-surface="settings"] button',
          );
          if (!header || !title || !settings) {
            throw new Error("The chat title or Settings control is missing from the header");
          }
          const headerBox = header.getBoundingClientRect();
          const titleBox = title.getBoundingClientRect();
          const settingsBox = settings.getBoundingClientRect();
          const overlap =
            titleBox.left < settingsBox.right &&
            titleBox.right > settingsBox.left &&
            titleBox.top < settingsBox.bottom &&
            titleBox.bottom > settingsBox.top;
          return {
            headerLeft: headerBox.left,
            headerRight: headerBox.right,
            titleLeft: titleBox.left,
            titleRight: titleBox.right,
            settingsLeft: settingsBox.left,
            titleTop: titleBox.top,
            settingsTop: settingsBox.top,
            overlap,
          };
        });
        expect(boxes.titleLeft).toBeGreaterThanOrEqual(boxes.headerLeft);
        expect(boxes.titleRight).toBeLessThanOrEqual(boxes.headerRight);
        expect(boxes.overlap, `${width}px: title and Settings overlap`).toBe(false);
        if (width >= 768) {
          expect(Math.abs(boxes.titleTop - boxes.settingsTop)).toBeLessThan(8);
          expect(boxes.titleRight).toBeLessThanOrEqual(boxes.settingsLeft);
        }

        await page.screenshot({
          animations: "disabled",
          path: join(screenshots, `fix-1650-header-title-${width}-${dark ? "dark" : "light"}.png`),
        });
      }
    }
    expect(realApp.problems).toEqual([]);
  },
);
