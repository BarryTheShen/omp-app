import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * #1055: the fake model has no slow mode, so omp refuses `/slow on`. The dialog must not show the change as made:
 * the row goes back to what omp last left it at, and the dialog says why in plain words. A `/slow on` typed in the
 * composer says the same in the header. omp's own words are not shown.
 */

const REFUSED = "Slow mode is not available for this model.";

/** Turns Slow mode on from the dialog and checks that omp's refusal is shown in plain words. */
async function refuseSlowFromDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Execution modes" }).click();
  const dialog = page.getByRole("dialog", { name: "Execution modes" });
  await expect(dialog).toBeVisible();
  const slow = dialog.getByRole("group", { name: "Slow mode controls" });
  await slow.getByRole("button", { name: "Turn on" }).click();
  await expect(dialog.getByText("Slow mode could not be changed.", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(dialog.getByText(REFUSED, { exact: true })).toBeVisible();
  await expect(slow.getByRole("button", { name: "Turn on" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(slow.getByRole("button", { name: "Turn off" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    dialog.getByText("The current model has no slow mode", { exact: false }),
  ).toHaveCount(0);
  await page.mouse.move(0, 0);
  return dialog;
}

realTest(
  "#1055 real omp: a refused Slow mode is shown as refused, in light, from the dialog and from the composer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    const dialog = await refuseSlowFromDialog(page);
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-dialog-light.png"),
    });
    await dialog.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-slow-row-light.png"),
    });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    await composer.fill("/slow on");
    await composer.press("Enter");
    await expect(page.getByText(REFUSED, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText("The current model has no slow mode", { exact: false }),
    ).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-composer-light.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1055 real omp: a refused Slow mode is shown as refused, in dark",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const composer = await startChat(page);
    const dialog = await refuseSlowFromDialog(page);
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-dialog-dark.png"),
    });
    await dialog.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-slow-row-dark.png"),
    });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await composer.fill("/slow on");
    await composer.press("Enter");
    await expect(page.getByText(REFUSED, { exact: true })).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-composer-dark.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1055 real omp: a refused Slow mode is shown as refused, at 390 px",
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
    const dialog = await refuseSlowFromDialog(page);
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-dialog-narrow.png"),
    });
    await dialog.getByRole("group", { name: "Slow mode controls" }).scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await dialog.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-slow-row-narrow.png"),
    });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    await composer.fill("/slow on");
    await composer.press("Enter");
    await expect(page.getByText(REFUSED, { exact: true })).toBeVisible({ timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1055-slow-refused-composer-narrow.png"),
    });
    expect(realApp.problems).toEqual([]);
  },
);
