import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #929. "Model Role Storage" (where role assignments and the saved default are persisted) sat first
 * in the Prompt section of Settings > Model. It now sits in the Thinking section, and the Prompt section
 * lists only prompt options.
 */

const HELP = "Where role assignments and the saved default are persisted.";

/** Opens Settings, its Model tab and one of that tab's sections. */
async function openModelSection(page: Page, section: string): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Model", exact: true }).click();
  await dialog.getByRole("option", { name: section, exact: true }).click();
  return dialog;
}

/** Centres the control in the dialog's scroll area, so a screenshot shows it with its help text. */
async function centre(control: Locator): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
}

realTest(
  "Model Role Storage is in the Thinking section, and the Prompt section lists only prompt options",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelSection(page, "Thinking");
    await expect(dialog.getByText("Model Role Storage", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByText(HELP, { exact: true })).toBeVisible();
    await centre(dialog.getByText("Model Role Storage", { exact: true }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-929-thinking-light.png") });

    await page.emulateMedia({ colorScheme: "dark" });
    await centre(dialog.getByText("Model Role Storage", { exact: true }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-929-thinking-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });

    await page.setViewportSize({ width: 390, height: 844 });
    await centre(dialog.getByText("Model Role Storage", { exact: true }));
    await expect(dialog.getByText(HELP, { exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-929-thinking-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    await dialog.getByRole("option", { name: "Prompt", exact: true }).click();
    await expect(dialog.getByText("Inline Tool Descriptors", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Model Role Storage", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(HELP, { exact: true })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
