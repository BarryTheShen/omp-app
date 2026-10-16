import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const REPORTS = "Reports";
const SECURITY = "Security";

async function openFromPalette(page: Page, query: string) {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search commands" }).fill(query);
  await palette.getByRole("option", { name: query }).click();
}

async function capturePanel(page: Page, title: string, theme: "light" | "dark" | "narrow") {
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: title, exact: true });
  await expect(panel).toBeVisible();
  await expect
    .poll(() => panel.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  const background = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, `fix-1629-${title.toLowerCase()}-${theme}.png`),
  });
}

async function closePanel(page: Page, title: string, composer: Locator) {
  await page.getByRole("button", { name: `Close ${title}` }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
  await expect(composer).toBeFocused();
}

async function escapePanel(page: Page, title: string, composer: Locator) {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: title, exact: true })).toHaveCount(0);
  await expect(composer).toBeFocused();
}

realTest("D6 reports and security panels open from their palette commands", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await mkdir(screenshots, { recursive: true });

  await composer.focus();
  await openFromPalette(page, "Show reports");
  await capturePanel(page, REPORTS, "light");
  await closePanel(page, REPORTS, composer);

  await composer.focus();
  await openFromPalette(page, "Security scans");
  await capturePanel(page, SECURITY, "light");
  await escapePanel(page, SECURITY, composer);

  await page.setViewportSize({ width: 390, height: 844 });
  await composer.focus();
  await openFromPalette(page, "Show reports");
  await capturePanel(page, REPORTS, "narrow");
  await closePanel(page, REPORTS, composer);

  await composer.focus();
  await openFromPalette(page, "Security scans");
  await capturePanel(page, SECURITY, "narrow");
  await escapePanel(page, SECURITY, composer);
});

realTest("D6 reports and security panels open in the dark theme", async ({ realApp }) => {
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await mkdir(screenshots, { recursive: true });
  await expect(page.locator("html")).toHaveClass(/dark/);

  await composer.focus();
  await openFromPalette(page, "Show reports");
  await capturePanel(page, REPORTS, "dark");
  await closePanel(page, REPORTS, composer);

  await composer.focus();
  await openFromPalette(page, "Security scans");
  await capturePanel(page, SECURITY, "dark");
  await escapePanel(page, SECURITY, composer);
});
realTest("a new command result replaces an open D6 panel", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await composer.focus();
  await openFromPalette(page, "Show reports");
  await expect(page.getByRole("heading", { name: REPORTS, exact: true })).toBeVisible();

  const slashCommands = page.getByRole("listbox", { name: "Slash commands" });
  await composer.fill("/tools");
  await expect(slashCommands.getByRole("option", { name: /^\/tools/ })).toBeVisible();
  await composer.press("Escape");
  await expect(slashCommands).toBeHidden();
  await expect(composer).toHaveValue("/tools");
  await composer.press("Enter");
  const commandOutput = page.getByRole("region", { name: "Command output" });
  await expect(commandOutput).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: REPORTS, exact: true })).toHaveCount(0);
  expect(realApp.problems).toEqual([]);
});
