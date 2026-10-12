import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * The fake model has no slow mode. The dialog's Slow mode row reads omp's typed state, so it shows the plain
 * reason with both buttons off. A `/slow on` typed in the composer is still read from omp's reply, and it says the
 * same thing in the header. omp's own words are not shown.
 */

const UNAVAILABLE = "Slow mode is not available for this model.";

/** Opens the dialog and checks that Slow mode is off and cannot be changed, with the plain reason on its row. */
async function openSlowUnavailable(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Execution modes" }).click();
  const dialog = page.getByRole("dialog", { name: "Execution modes" });
  await expect(dialog).toBeVisible();
  const slow = dialog.getByRole("group", { name: "Slow mode controls" });
  await expect(dialog.getByText(UNAVAILABLE, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(slow.getByRole("button", { name: "Turn on" })).toBeDisabled();
  await expect(slow.getByRole("button", { name: "Turn off" })).toBeDisabled();
  await page.mouse.move(0, 0);
  return dialog;
}

realTest(
  "#1200 real omp: the dialog shows Slow mode as not available, and /slow on in the composer says so, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    const dialog = await openSlowUnavailable(page);
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-unavailable-dialog-light.png"),
    });
    await dialog.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-unavailable-row-light.png"),
    });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    await composer.fill("/slow on");
    await composer.press("Enter");
    await expect(page.getByText(UNAVAILABLE, { exact: true })).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-refused-composer-light.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1200 real omp: the dialog shows Slow mode as not available, and /slow on in the composer says so, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await startChat(page);
    const dialog = await openSlowUnavailable(page);
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-unavailable-dialog-dark.png"),
    });
    await dialog.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-unavailable-row-dark.png"),
    });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await composer.fill("/slow on");
    await composer.press("Enter");
    await expect(page.getByText(UNAVAILABLE, { exact: true })).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-refused-composer-dark.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1200 real omp: the dialog shows Slow mode as not available, and /slow on in the composer says so, at 390 px",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    // The sessions sidebar (with New chat) is hidden at 390 px, so the chat starts first, then the view narrows.
    const composer = await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openSlowUnavailable(page);
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-unavailable-dialog-narrow.png"),
    });
    await dialog.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-unavailable-row-narrow.png"),
    });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await composer.fill("/slow on");
    await composer.press("Enter");
    await expect(page.getByText(UNAVAILABLE, { exact: true })).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1200-slow-refused-composer-narrow.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);
