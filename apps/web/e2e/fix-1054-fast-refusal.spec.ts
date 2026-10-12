/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * #1054: a Fast mode change that the fake model refuses shows one notice, in plain words: the Execution modes
 * dialog's sentence. omp's own info notice about `/fast` must not also appear in the notices line above the composer.
 */

const REFUSED = "Fast mode could not be changed.";
const REASON = "Fast mode is unavailable for the current model.";
const OMP_WORDS = "service-tier";

realTest.setTimeout(420_000);

/** Asks omp to turn Fast mode on from the dialog and waits until the dialog shows the refusal. */
async function refuseFastFromDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Execution modes" }).click();
  const dialog = page.getByRole("dialog", { name: "Execution modes" });
  await expect(dialog).toBeVisible();
  const fast = dialog.getByRole("group", { name: "Fast mode controls" });
  await fast.getByRole("button", { name: "Turn on" }).click();
  await expect(dialog.getByText(REFUSED, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByText(REASON, { exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  return dialog;
}

/** One notice only: the notices line from omp stays hidden, and omp's own words are not on the page. */
async function expectOneNotice(page: Page): Promise<void> {
  await expect(page.getByRole("region", { name: "Notices from omp" })).toBeHidden();
  await expect(page.getByText(OMP_WORDS, { exact: false })).toHaveCount(0);
}

realTest(
  "#1054: a refused Fast mode change shows one notice, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await startChat(page);
    await refuseFastFromDialog(page);
    await expectOneNotice(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1054-light.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1054: a refused Fast mode change shows one notice, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    // The saved theme is set before the page loads, the way a person who chose Dark gets it.
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await startChat(page);
    await refuseFastFromDialog(page);
    await expectOneNotice(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1054-dark.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1054: a refused Fast mode change shows one notice, at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await refuseFastFromDialog(page);
    await expectOneNotice(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1054-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
