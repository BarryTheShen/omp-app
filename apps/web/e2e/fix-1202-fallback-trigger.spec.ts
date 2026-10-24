import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

// The Fallback Trigger (retry.fallbackOn) needs omp 18.9.0 or newer; the harness default binary is older.

/**
 * Issue #1202. omp 18.9.0 added `retry.fallbackOn`, the Fallback Trigger: which failed requests may switch to a
 * configured fallback model. Retry & Fallback in the Model tab shows it, and a change is saved to omp's config.yml.
 */

/** Opens Settings, its Model tab and the Retry & Fallback section. */
async function openRetryAndFallback(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Model", exact: true }).click();
  await dialog.getByRole("option", { name: "Retry & Fallback", exact: true }).click();
  return dialog;
}

/** Centres the Fallback Trigger in the dialog's scroll area, so a screenshot shows it with its help text. */
async function centre(control: Locator): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
}

/** The background colour the dialog is painted with now. */
async function backgroundOf(dialog: Locator): Promise<string> {
  return dialog.evaluate((element) => getComputedStyle(element).backgroundColor);
}

realTest(
  "the Fallback Trigger offers the three choices, and 'usage limit only' is saved to omp's config and shown after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });

    let dialog = await openRetryAndFallback(page);
    const trigger = dialog.getByRole("combobox", { name: "Fallback Trigger" });
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(trigger.locator("option")).toHaveText([
      "Any error",
      "Usage limit only",
      "Errors other than usage limits",
    ]);
    await trigger.selectOption("usage-limit");
    const save = dialog.getByRole("button", { name: "Save changes" });
    await save.click();
    await expect(save).toBeDisabled({ timeout: 20_000 });
    await expect(dialog.getByRole("alert")).toHaveCount(0);

    // Save disables as the write starts, before omp has written the file: wait for the line rather than read it once.
    await expect
      .poll(() => readFile(join(realApp.agentDir, "config.yml"), "utf8"), { timeout: 20_000 })
      .toMatch(/^\s+fallbackOn:\s*["']?usage-limit["']?\s*$/m);

    await page.reload();
    dialog = await openRetryAndFallback(page);
    const reloaded = dialog.getByRole("combobox", { name: "Fallback Trigger" });
    await expect(reloaded).toHaveValue("usage-limit", { timeout: 20_000 });
    await centre(reloaded);
    expect(await backgroundOf(dialog)).not.toBe("rgba(0, 0, 0, 0)");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1202-trigger-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the Fallback Trigger reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open();
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialog = await openRetryAndFallback(page);
  const trigger = dialog.getByRole("combobox", { name: "Fallback Trigger" });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  const light = await backgroundOf(dialog);

  // The app follows the system's colour scheme, so switching the scheme switches the app.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(() => backgroundOf(dialog), { timeout: 10_000 }).not.toBe(light);
  await centre(trigger);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1202-trigger-dark.png") });
  expect(realApp.problems).toEqual([]);
});

realTest("the Fallback Trigger fits a 390 px phone", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open();
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openRetryAndFallback(page);
  const trigger = dialog.getByRole("combobox", { name: "Fallback Trigger" });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  await centre(trigger);
  await waitForFiniteAnimations(page);
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await page.screenshot({ path: join(screenshots, "fix-1202-trigger-narrow.png") });
  expect(realApp.problems).toEqual([]);
});
