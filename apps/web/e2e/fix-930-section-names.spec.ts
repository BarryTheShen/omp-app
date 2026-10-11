import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #930. Each settings section name repeated its tab ("Files / Editing"), and the Providers
 * tab showed "Providers / Services" twice. A section now has a short name, and its list row and
 * its heading show that same name.
 */

const TABS = ["Interaction", "Model", "Files", "Shell", "Tools", "Tasks", "Providers"] as const;

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
}

realTest(
  "each settings tab names its sections in plain words, and the heading matches its list row",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await openSettings(page);
    const settings = page.getByTestId("settings-screen");
    for (const tab of TABS) {
      await settings.getByRole("button", { name: tab, exact: true }).click();
      const list = page.getByRole("listbox", { name: `${tab} settings sections` });
      await expect(list).toBeVisible();
      const names = (await list.getByRole("option").allTextContents()).map((name) => name.trim());
      expect(names.length, `${tab} has sections`).toBeGreaterThan(0);
      for (const name of names) expect(name, tab).not.toContain(" / ");
      const first = names[0] ?? "";
      await list.getByRole("option").first().click();
      await expect(
        page.getByRole("heading", { name: first, exact: true }).first(),
        `${tab} heading`,
      ).toBeVisible();
    }
    await expect(page.getByRole("option", { name: "Services", exact: true })).toBeVisible();
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-930-providers-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Providers section reads Services in dark and at 390 px, once as its row and once as its heading",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await openSettings(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    const settings = page.getByTestId("settings-screen");
    await settings.getByRole("button", { name: "Providers", exact: true }).click();
    await expect(page.getByRole("option", { name: "Services", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-930-providers-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-930-providers-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
