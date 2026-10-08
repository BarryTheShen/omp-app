import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/** One fake extension file in the agent's extensions folder, so omp's catalog lists an item. */
const FAKE_EXTENSION = "fake-catalog-extension.ts";
realTest.use({
  seedExtensions: { [FAKE_EXTENSION]: "export default function fakeCatalogExtension() {}\n" },
});

/** Opens Settings from the header and selects its Tools tab, where the control center sits. */
async function openToolsTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Tools", exact: true }).click();
}

realTest(
  "the Tools tab lists the seeded extension from the real host, and the provider tabs open from the keyboard",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openToolsTab(page);
    await expect(page.getByTestId("extension-control-center")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Close Extension Control Center", exact: true }),
    ).toHaveCount(0);
    const extensionsTab = page.getByTestId("extension-tab-extensions");
    const skillsTab = page.getByTestId("extension-tab-skills");
    // The selected provider tab carries aria-selected="true"; the other tabs carry "false".
    await skillsTab.focus();
    await page.keyboard.press("Enter");
    await expect(skillsTab).toHaveAttribute("aria-selected", "true");
    await expect(extensionsTab).toHaveAttribute("aria-selected", "false");
    await extensionsTab.focus();
    await page.keyboard.press("Enter");
    await expect(extensionsTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`extension-item-${FAKE_EXTENSION}`)).toBeVisible();
    await expect(page.getByText("Select an item to see its details.")).toBeVisible();
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-extension-center-light.png"),
      fullPage: true,
    });
  },
);

realTest(
  "the extension control center reads in dark and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await openToolsTab(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("extension-control-center")).toBeVisible();
    await expect(page.getByTestId(`extension-item-${FAKE_EXTENSION}`)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-extension-center-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("extension-control-center")).toBeVisible();
    const settingsBox = await page.getByTestId("settings-screen").boundingBox();
    expect((settingsBox?.x ?? 0) + (settingsBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-extension-center-narrow.png"),
      fullPage: true,
    });
  },
);
