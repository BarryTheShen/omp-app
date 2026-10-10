import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * A press on the dimmed area outside a dialog closes it (#960). A dialog with unsaved Settings edits
 * asks before it closes, so nothing is lost silently. Escape keeps closing as it did, and focus returns
 * to the control that opened the dialog. The question is captured in light, dark and at 390 px.
 * omp's own question stays open when a press lands outside it: only an answer or Escape ends it.
 */

const QUESTION = "Discard unsaved changes?";

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** A press on the dimmed area, well away from the dialog. */
async function pressDimmedArea(page: Page): Promise<void> {
  await page.mouse.click(6, 6);
}

/**
 * Changes Steering Mode without saving it. The dialog then reports its unsaved edits, and the helper
 * waits for that report: a press before it would read the dialog as clean, as no person's press would.
 */
async function stageSteeringMode(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: "Interaction", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Steering Mode" }).selectOption("all");
  await expect(dialog).toHaveAttribute("data-overlay-unsaved", "true");
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name) });
}

realTest(
  "a press on the dimmed area closes Settings, and focus returns to the Settings button",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);
    await pressDimmedArea(page);
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "Escape still closes Settings at once, as it did before",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSettings(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "unsaved Settings edits are asked about before a press or the Close button discards them, in light",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(
          (value) => window.localStorage.setItem("omp-app.theme", value),
          "light",
        ),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openSettings(page);
    await stageSteeringMode(dialog);

    await pressDimmedArea(page);
    const question = page.getByRole("alertdialog", { name: QUESTION, exact: true });
    await expect(question).toBeVisible();
    await expect(dialog).toBeVisible();
    await capture(page, "fix-960-discard-light.png");

    // Keep editing: the question goes and the edit stays.
    await question.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(question).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: "Steering Mode" })).toHaveValue("all");

    // The Close button asks too.
    await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect(question).toBeVisible();

    // Discard changes: Settings closes, and the unsaved edit is gone when it opens again.
    await question.getByRole("button", { name: "Discard changes", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toHaveCount(0);
    const reopened = await openSettings(page);
    await reopened.getByRole("button", { name: "Interaction", exact: true }).click();
    await expect(reopened.getByRole("combobox", { name: "Steering Mode" })).toHaveValue(
      "one-at-a-time",
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the discard question reads in dark", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(150_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript((value) => window.localStorage.setItem("omp-app.theme", value), "dark"),
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialog = await openSettings(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await stageSteeringMode(dialog);
  await pressDimmedArea(page);
  await expect(page.getByRole("alertdialog", { name: QUESTION, exact: true })).toBeVisible();
  await capture(page, "fix-960-discard-dark.png");
  expect(realApp.problems).toEqual([]);
});

realTest("the discard question fits a 390 px phone", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(150_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript((value) => window.localStorage.setItem("omp-app.theme", value), "light"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const dialog = await openSettings(page);
  await stageSteeringMode(dialog);
  await pressDimmedArea(page);
  const question = page.getByRole("alertdialog", { name: QUESTION, exact: true });
  await expect(question).toBeVisible();
  await expect(question).toBeInViewport();
  await capture(page, "fix-960-discard-narrow.png");
  expect(realApp.problems).toEqual([]);
});

realTest(
  "a press on the dimmed area closes the model dialog, and focus returns to its control",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(150_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await startChat(page);
    const control = page.getByRole("button", { name: /Change model or thinking/ });
    await control.click();
    const model = page.getByRole("dialog", { name: "Model and thinking", exact: true });
    await expect(model).toBeVisible();
    await pressDimmedArea(page);
    await expect(model).toHaveCount(0);
    await expect(control).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a press on the dimmed area leaves omp's question open, and the answer still continues the turn",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    // The fake provider answers a prompt containing "ask_user" with omp's ask tool (see app.spec.ts).
    await sendPrompt(composer, "Please ask_user which database to use.");
    const question = page.getByRole("dialog");
    await expect(question).toContainText("Which database?", { timeout: 45_000 });
    await pressDimmedArea(page);
    // The press neither answered nor cancelled the question: it is still there, and an answer goes through.
    await expect(question).toBeVisible();
    await question.getByText("SQLite").first().click();
    await question
      .getByRole("button", { name: /choose/i })
      .first()
      .click();
    await expect(page.getByText(/tool said:/)).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
