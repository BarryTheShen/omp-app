import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("settings-screen")).toBeVisible();
}

realTest(
  "the settings tabs list the files, tools and providers sections, and a tab opens from the keyboard",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openSettings(page);
    const settings = page.getByTestId("settings-screen");
    await settings.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.getByRole("listbox", { name: "Files settings sections" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Files \/ Editing/ })).toBeVisible();
    await settings.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(page.getByRole("option", { name: /Available Tools/ })).toBeVisible();
    // Keyboard: focus the Providers tab and press Enter to open it.
    await settings.getByRole("button", { name: "Providers", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox", { name: "Providers settings sections" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Providers \/ Services/ })).toBeVisible();
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-settings-sections-light.png"),
      fullPage: true,
    });
  },
);

realTest("the settings tabs read in dark and at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open();
  await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
  await page.reload();
  await openSettings(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  const settings = page.getByTestId("settings-screen");
  await settings.getByRole("button", { name: "Shell", exact: true }).click();
  await expect(page.getByRole("option", { name: /Shell \/ Bash/ })).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "app-settings-sections-dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("option", { name: /Shell \/ Bash/ })).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "app-settings-sections-narrow.png"),
    fullPage: true,
  });
});
