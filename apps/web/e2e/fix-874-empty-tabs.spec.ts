import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * #874 on real omp: with no extensions installed, each provider tab of the Extension Control Center says what is
 * missing in its own words. "No matching ..." appears only for a search that finds nothing, never "No matching
 * providers." on an empty tab.
 */

/** Opens Settings from the header and selects its Tools tab, where the control center sits. */
async function openToolsTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Tools", exact: true }).click();
}

realTest(
  "each empty provider tab says what is missing, and only a search with no result says No matching",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openToolsTab(page);
    await expect(page.getByTestId("extension-control-center")).toBeVisible();

    await expect(page.getByText("No extensions installed.", { exact: true })).toBeVisible();
    for (const [tab, text] of [
      ["skills", "No skills found."],
      ["prompts", "No prompts found."],
      ["plugins", "No plugins installed."],
    ] as const) {
      await page.getByTestId(`extension-tab-${tab}`).click();
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    }

    await page.getByRole("textbox", { name: "Search extensions" }).fill("zzz");
    await expect(page.getByText("No matching plugins.", { exact: true })).toBeVisible();
    await expect(page.getByText("No matching providers.")).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
