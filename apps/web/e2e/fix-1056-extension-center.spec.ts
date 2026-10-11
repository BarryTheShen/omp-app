import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1056 on real omp, in the Extension Control Center on the Tools tab: the Prompts tab counts its prompts, not the
 * extensions beside them; a tab names no count until the catalog has been read; and a failed load says its sentence once.
 */

const FAKE_EXTENSION = "fake-catalog-extension.ts";
const FAKE_SOURCE = "export default function fakeCatalogExtension() {}\n";
/** The panel's heading, and the sentence the catalog gives for a folder it cannot read. */
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

realTest.describe("with one extension installed", () => {
  realTest.use({ seedExtensions: { [FAKE_EXTENSION]: FAKE_SOURCE } });

  realTest(
    "the Prompts tab counts its prompts, not the extension beside them, and the list under it agrees",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      const page = await realApp.open();
      await openToolsTab(page);
      await expect(page.getByTestId("extension-tab-extensions")).toHaveAttribute(
        "aria-label",
        "Extensions, 1 item",
      );
      await page.getByTestId("extension-tab-prompts").click();
      await expect(page.getByTestId("extension-tab-prompts")).toHaveAttribute(
        "aria-label",
        "Prompts, 0 items",
      );
      await expect(page.getByText("No prompts found.", { exact: true })).toBeVisible();
      await waitForFiniteAnimations(page);
      await mkdir(screenshots, { recursive: true });
      await page.screenshot({
        path: join(screenshots, "fix-1056-prompts-light.png"),
        fullPage: true,
      });
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a catalog that cannot be read names no count on any tab",
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(180_000);
      // The extensions folder is unreadable while the panel loads, so the catalog read fails. It is restored after.
      const extensions = join(realApp.agentDir, "extensions");
      await chmod(extensions, 0o000);
      try {
        const page = await realApp.open();
        await openToolsTab(page);
        await expect(page.getByText(FAILED_HEADING, { exact: true })).toBeVisible({
          timeout: 30_000,
        });
        for (const [id, label] of [
          ["extensions", "Extensions"],
          ["skills", "Skills"],
          ["prompts", "Prompts"],
          ["plugins", "Plugins"],
        ] as const) {
          await expect(page.getByTestId(`extension-tab-${id}`)).toHaveAttribute(
            "aria-label",
            label,
          );
        }
      } finally {
        await chmod(extensions, 0o755);
      }
    },
  );

  realTest("a failed load says its sentence once", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const extensions = join(realApp.agentDir, "extensions");
    await chmod(extensions, 0o000);
    try {
      const page = await realApp.open();
      await openToolsTab(page);
      await expect(page.getByText(FAILED_HEADING, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(FAILED_SENTENCE, { exact: true })).toHaveCount(1);
    } finally {
      await chmod(extensions, 0o755);
    }
  });

  realTest("the Prompts tab reads in dark and at 390 px", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await openToolsTab(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByTestId("extension-tab-prompts").click();
    await expect(page.getByText("No prompts found.", { exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1056-prompts-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText("No prompts found.", { exact: true })).toBeVisible();
    const settingsBox = await page.getByTestId("settings-screen").boundingBox();
    expect((settingsBox?.x ?? 0) + (settingsBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1056-prompts-narrow.png"),
      fullPage: true,
    });
  });
});
