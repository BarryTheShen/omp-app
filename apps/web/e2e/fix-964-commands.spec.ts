import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** omp's slash command list above the composer. */
function commandList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** Captures the open dialog in light, dark and at 390 px, leaving the page in light at its wide width. */
async function captureDialogThreeWays(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(screenshots, `${name}-light.png`) });
  await setTheme(page, true);
  await page.screenshot({ path: join(screenshots, `${name}-dark.png`) });
  await setTheme(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.screenshot({ path: join(screenshots, `${name}-narrow.png`) });
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** Types a command and presses Enter on it: a command with no arguments runs when Enter chooses it. */
async function sendTypedCommand(page: Page, composer: Locator, command: string): Promise<void> {
  await composer.fill(`/${command}`);
  await expect(
    commandList(page).getByRole("option", { name: new RegExp(`^/${command}`) }),
  ).toBeVisible({ timeout: 30_000 });
  await composer.press("Enter");
}

realTest(
  "#964 part 3: typing /settings and sending it opens the app's Settings; Escape returns focus to the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendTypedCommand(page, composer, "settings");

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Composer Shape", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expectStylesLoaded(page);
    await captureDialogThreeWays(page, "fix-964-p3-settings");

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#964 part 3: typing /hotkeys and sending it opens the shortcut sheet; the palette's Keyboard shortcuts item opens it too",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendTypedCommand(page, composer, "hotkeys");

    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await expectStylesLoaded(page);
    await captureDialogThreeWays(page, "fix-964-p3-hotkeys");
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);

    // The palette item opens the same sheet.
    await composer.click();
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "Search commands" }).fill("keyboard");
    await page.getByRole("option", { name: /^Keyboard shortcuts/ }).click();
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
