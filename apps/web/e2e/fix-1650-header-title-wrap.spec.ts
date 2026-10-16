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
  "the chat title takes its own row when narrow and stays beside controls at wide widths",
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
    const title = page.locator('[data-layout-area="header"] [data-surface="title"] p');
    await expect(title).toHaveText(CHAT_TITLE);
    const model = page.locator('[data-layout-area="header"] [data-surface="model"]');
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
        await expect(title).toHaveCSS("font-size", "12px");
        const boxes = await page.evaluate(() => {
          const titleSurface = document.querySelector<HTMLElement>(
            '[data-layout-area="header"] [data-surface="title"]',
          );
          const modelSurface = document.querySelector<HTMLElement>(
            '[data-layout-area="header"] [data-surface="model"]',
          );
          if (!titleSurface || !modelSurface)
            throw new Error("The chat title or model control is missing");
          const titleBox = titleSurface.getBoundingClientRect();
          const modelBox = modelSurface.getBoundingClientRect();
          return {
            titleTop: titleBox.top,
            titleBottom: titleBox.bottom,
            titleRight: titleBox.right,
            modelTop: modelBox.top,
            modelLeft: modelBox.left,
          };
        });

        if (width <= 390) expect(boxes.titleBottom).toBeLessThanOrEqual(boxes.modelTop);
        else {
          expect(Math.abs(boxes.titleTop - boxes.modelTop)).toBeLessThan(8);
          expect(boxes.titleRight).toBeLessThanOrEqual(boxes.modelLeft);
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
