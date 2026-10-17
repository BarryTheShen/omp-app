import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  return settings;
}

async function openAppearanceDisplay(settings: Locator): Promise<Locator> {
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  await settings.getByRole("tab", { name: "Display", exact: true }).click();
  const section = settings.locator('[data-s1-appearance-section="S1.appearanceDisplay"]');
  await expect(section).toBeVisible();
  return section;
}

async function openTasksModes(settings: Locator): Promise<Locator> {
  await settings.getByRole("button", { name: "Tasks", exact: true }).click();
  await settings.getByRole("option", { name: "Modes", exact: true }).click();
  const section = settings.getByRole("region", { name: "Tasks settings", exact: true });
  await expect(section).toBeVisible();
  return section;
}

realTest(
  "session title icon and generator settings save to omp and survive reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });

    let settings = await openSettings(page);
    let display = await openAppearanceDisplay(settings);
    const icons = display.getByRole("combobox", { name: "Title Icons" });
    await expect(icons).toBeVisible({ timeout: 30_000 });
    await expect(icons.locator("option")).toHaveText(["Nerd Font + Emoji", "Emoji", "Boring"]);
    await icons.selectOption("boring");
    let save = display.getByRole("button", { name: "Save changes" });
    await save.click();
    await expect(save).toBeDisabled({ timeout: 20_000 });

    const modes = await openTasksModes(settings);
    const generator = modes.getByRole("combobox", { name: "Title Generator" });
    await expect(generator).toBeVisible({ timeout: 30_000 });
    await expect(generator.locator("option")).toHaveText(["Fork", "Tiny"]);
    await generator.selectOption("tiny");
    save = modes.getByRole("button", { name: "Save changes" });
    await save.click();
    await expect(save).toBeDisabled({ timeout: 20_000 });
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/^\s+icons:\s*boring\s*$/m);
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/^\s+generator:\s*tiny\s*$/m);

    await page.reload();
    settings = await openSettings(page);
    display = await openAppearanceDisplay(settings);
    await expect(display.getByRole("combobox", { name: "Title Icons" })).toHaveValue("boring");
    await display.getByRole("combobox", { name: "Title Icons" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1908-title-settings-light.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const narrowModes = await openTasksModes(settings);
    await expect(narrowModes.getByRole("combobox", { name: "Title Generator" })).toHaveValue(
      "tiny",
    );
    await narrowModes.getByRole("combobox", { name: "Title Generator" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1908-title-settings-narrow.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    display = await openAppearanceDisplay(settings);
    await display.getByRole("combobox", { name: "Title Icons" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1908-title-settings-dark.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
