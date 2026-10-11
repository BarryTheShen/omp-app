import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { appWrittenText, INTERNAL_WORDS } from "./d7-plain-text";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * One real-omp check per mode the dialog changes: the dialog opens from the composer's button, the change is made,
 * and omp's typed answer shows in plain words. The app's own words in the controls stay plain, and no omp reply is
 * shown for a typed answer.
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

/** The controls are plain: no omp reply is shown, and the app's words hold no internal name. The dialog is kept. */
async function expectPlainControls(page: Page, dialog: Locator, name: string): Promise<void> {
  await expect(dialog.getByRole("status").filter({ hasText: "Sent to omp." })).toHaveCount(0);
  expect(await appWrittenText(page)).not.toMatch(INTERNAL_WORDS);
  await waitForFiniteAnimations(page);
  await dialog.screenshot({
    animations: "disabled",
    path: join(screenshots, `fix-1055-real-${name}-light.png`),
  });
}

realTest(
  "#1055 real omp: Computer use turns on from the dialog, and the row reads On",
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
    await expect(dialog.getByText("On", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    await expect(computer.getByRole("button", { name: "Turn on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expectPlainControls(page, dialog, "computer");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1055 real omp: Extended context turns on from the dialog, and the row reads On",
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
    await expect(dialog.getByText("On", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    await expect(extended.getByRole("button", { name: "Turn on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expectPlainControls(page, dialog, "extended-context");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1055 real omp: Slow mode is refused on the fake model, and the choice is not shown as made",
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
    await expect(dialog.getByText("Slow mode could not be changed.", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      dialog.getByText("Slow mode is not available for this model.", { exact: true }),
    ).toBeVisible();
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
    await expectPlainControls(page, dialog, "slow");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#1055 real omp: Browser use shows a visible window from the dialog, and the row says it is set",
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
    await expect(
      dialog.getByText(
        "Set for this chat. omp does not say whether its browser window is visible.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole("button", { name: "Visible window" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectPlainControls(page, dialog, "browser");
    expect(realApp.problems).toEqual([]);
  },
);
