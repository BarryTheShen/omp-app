import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1078 on real omp: the extension catalog cannot read its folder, so the Tools tab's panel says so in the catalog's
 * own plain sentence. No internal word shows. Captured in light, dark and at 390 px.
 */

const FAILED_HEADING = "Unable to load this panel";
const FAILED_SENTENCE = "Unable to read the installed extensions.";

/** Opens Settings from the header and selects its Tools tab, where the control center sits. */
async function openToolsTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByTestId("extension-control-center")).toBeVisible();
}

realTest(
  "a catalog that cannot read its folder says so in plain words, in light, dark and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    // The extensions folder is unreadable while the panel loads, so the catalog read fails for real. It is restored after.
    const extensions = join(realApp.agentDir, "extensions");
    await mkdir(extensions, { recursive: true });
    await chmod(extensions, 0o000);
    try {
      const page = await realApp.open();
      await openToolsTab(page);
      await expect(page.getByText(FAILED_HEADING, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(FAILED_SENTENCE, { exact: true })).toHaveCount(1);
      // A person never reads the internal word.
      await expect(page.getByText(/port handler/i)).toHaveCount(0);
      await waitForFiniteAnimations(page);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({
        path: join(screenshots, "fix-1078-catalog-failed-light.png"),
        fullPage: true,
      });

      await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
      await page.reload();
      await openToolsTab(page);
      await expect(page.locator("html")).toHaveClass(/dark/);
      await expect(page.getByText(FAILED_SENTENCE, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, "fix-1078-catalog-failed-dark.png"),
        fullPage: true,
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByText(FAILED_SENTENCE, { exact: true })).toBeVisible();
      const settingsBox = await page.getByTestId("settings-screen").boundingBox();
      expect((settingsBox?.x ?? 0) + (settingsBox?.width ?? 0)).toBeLessThanOrEqual(390);
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, "fix-1078-catalog-failed-narrow.png"),
        fullPage: true,
      });
    } finally {
      await chmod(extensions, 0o755);
    }
  },
);
