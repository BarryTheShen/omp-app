import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/** Ctrl+K opens the palette with its search focused; typing and Enter run the first match by keyboard. */
async function runFromPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

/** The composer's text box: focus must be on it once a palette command's dialog has closed. */
function composerOf(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

/** The shell draws with the app's own background: a transparent one means no styles loaded. */
async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "#823: the palette runs model, thinking, theme and Settings by keyboard, and focus returns to the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = composerOf(page);
    await startChat(page);
    await composer.click();

    // Model and thinking level: the Done button closes the dialog.
    await runFromPalette(page, "model");
    const model = page.getByRole("dialog", { name: "Model and thinking" });
    await expect(model).toBeVisible();
    await model.getByRole("button", { name: "Done" }).click();
    await expect(model).toHaveCount(0);
    await expect(composer).toBeFocused();

    // The same command, found by "thinking"; Escape closes the dialog.
    await runFromPalette(page, "thinking");
    await expect(model).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(model).toHaveCount(0);
    await expect(composer).toBeFocused();

    // Theme: the palette lists the three choices, then "dark theme" runs the one that makes the app dark.
    await page.keyboard.press("Control+k");
    await page.keyboard.type("theme");
    await expect(page.getByRole("option", { name: "Use the dark theme" })).toBeVisible();
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-823-palette-light.png") });
    await page.keyboard.press("Control+a");
    await page.keyboard.type("dark theme");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(composer).toBeFocused();

    // Settings: Escape closes the screen.
    await runFromPalette(page, "settings");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await expect(settings).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest("#823: the palette's model command in dark theme", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(300_000);
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = composerOf(page);
  await startChat(page);
  await composer.click();

  await page.keyboard.press("Control+k");
  await page.keyboard.type("model");
  await expect(page.getByRole("option", { name: "Model and thinking level" })).toBeVisible();
  await expectStylesLoaded(page);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-823-palette-dark.png") });
  await page.keyboard.press("Enter");
  const model = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(model).toBeVisible();
  await model.getByRole("button", { name: "Done" }).click();
  await expect(composer).toBeFocused();
  expect(realApp.problems).toEqual([]);
});

realTest(
  "#823: at 390 px the palette fits, and its model command returns focus to the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = composerOf(page);
    await startChat(page);
    // The window is narrow before the palette opens, because the palette lays out its list on open.
    await page.setViewportSize({ width: 390, height: 844 });
    await composer.click();

    await page.keyboard.press("Control+k");
    await page.keyboard.type("model");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(page.getByRole("option", { name: "Model and thinking level" })).toBeVisible();
    const box = await palette.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-823-palette-narrow.png") });

    await page.keyboard.press("Enter");
    const model = page.getByRole("dialog", { name: "Model and thinking" });
    await expect(model).toBeVisible();
    await model.getByRole("button", { name: "Done" }).click();
    await expect(composer).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);
