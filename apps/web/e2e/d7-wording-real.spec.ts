import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { appWrittenText, INTERNAL_WORDS } from "./d7-plain-text";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * One real-omp check per mode: the dialog opens from the composer's button, the mode is turned on, omp answers,
 * and the words the app wrote in the controls stay plain. omp's own reply is shown as omp wrote it, so the scan
 * leaves it out.
 */

function composerOf(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

async function openControls(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Execution modes" }).click();
  const dialog = page.getByRole("dialog", { name: "Execution modes" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Omp answered: exactly one row now reads "Sent to omp." (with omp's reply after it), no error shows, and the
 * app's own words in the controls are plain. The dialog is kept as a screenshot of that state.
 */
async function expectAnswered(page: Page, dialog: Locator, name: string): Promise<void> {
  await expect(dialog.getByRole("status").filter({ hasText: "Sent to omp." })).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await appWrittenText(page)).not.toMatch(INTERNAL_WORDS);
  await waitForFiniteAnimations(page);
  await dialog.screenshot({
    animations: "disabled",
    path: join(screenshots, `fix-1048-real-${name}-light.png`),
  });
}

realTest(
  "#1048 real omp: Computer use turns on from the dialog, and the app's words stay plain",
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
    const dialog = await openControls(page);
    const computer = dialog.getByRole("group", { name: "Computer use controls" });
    await computer.getByRole("button", { name: "Turn on" }).click();
    await expectAnswered(page, dialog, "computer");
    await expect(computer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1048 real omp: Extended context turns on from the dialog, and the app's words stay plain",
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
    const dialog = await openControls(page);
    const extended = dialog.getByRole("group", { name: "Extended context controls" });
    await extended.getByRole("button", { name: "Turn on" }).click();
    await expectAnswered(page, dialog, "extended-context");
    await expect(extended.getByRole("button", { name: "Turn on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1048 real omp: Slow mode turns on from the dialog, and the app's words stay plain",
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
    const dialog = await openControls(page);
    const slow = dialog.getByRole("group", { name: "Slow mode controls" });
    await slow.getByRole("button", { name: "Turn on" }).click();
    await expectAnswered(page, dialog, "slow");
    await expect(slow.getByRole("button", { name: "Turn on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1048 real omp: Browser use shows a visible window from the dialog, and the app's words stay plain",
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
    const dialog = await openControls(page);
    await dialog.getByRole("button", { name: "Visible window" }).click();
    await expectAnswered(page, dialog, "browser");
    await expect(dialog.getByRole("button", { name: "Visible window" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(realApp.problems).toEqual([]);
  },
);
