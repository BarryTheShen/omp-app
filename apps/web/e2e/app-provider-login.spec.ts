import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** Opens Settings from the header and selects its Providers tab. */
async function openProvidersTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Providers", exact: true }).click();
}

realTest(
  "the Providers tab says to open a chat when none is open, and shows provider sign-in for the open chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await openProvidersTab(page);
    await expect(page.getByText("Open a chat to sign in to a provider.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log in" })).toHaveCount(0);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();

    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByTestId("settings-screen");
    await expect(settings).toBeVisible();
    const providersTab = settings.getByRole("button", { name: "Providers", exact: true });
    await providersTab.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Provider login").first()).toBeVisible();
    await expect(page.getByText("Open a chat to sign in to a provider.")).toHaveCount(0);
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-provider-login-light.png"),
      fullPage: true,
    });
  },
);

realTest(
  "the provider sign-in section reads in dark and at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    const composer = await startChat(page);
    await sendPrompt(composer, "pong");
    await expect(page.getByText("pong").first()).toBeVisible({ timeout: 60_000 });
    await openProvidersTab(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByText("Provider login").first()).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-provider-login-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText("Provider login").first()).toBeVisible();
    const settingsBox = await page.getByTestId("settings-screen").boundingBox();
    expect((settingsBox?.x ?? 0) + (settingsBox?.width ?? 0)).toBeLessThanOrEqual(390);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "app-provider-login-narrow.png"),
      fullPage: true,
    });
  },
);
