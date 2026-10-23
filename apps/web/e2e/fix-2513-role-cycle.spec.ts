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
 * Issue #2513. Ctrl+P steps through the role models in omp's cycle order (Fast, Default, Thinking), and
 * Shift+Ctrl+P steps back. Each step changes the chat's model, which the header's model button names.
 */

const FAKE_HAIKU = /fake\/claude-3-haiku-20240307 ·/;
const FAKE_SONNET = /fake\/claude-3-5-sonnet-20240620 ·/;
const FAKE_FABLE = /fake\/claude-fable-5 ·/;

/** The header's model button, which names the session's model. */
function headerModel(page: Page): Locator {
  return page.locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]');
}

/** Starts a chat, waits for omp's first answer, and opens the chat's model dialog from the header button. */
async function openModelDialog(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
  await headerModel(page).click();
  const dialog = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Closes the dialog and opens it again from the header, as a person would. */
async function reopenModelDialog(page: Page, dialog: Locator): Promise<Locator> {
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await headerModel(page).click();
  const reopened = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(reopened).toBeVisible();
  return reopened;
}

/** The Roles view, opened from the dialog's sidebar. */
async function openRoles(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: /^Roles/ }).click();
  await expect(dialog.getByRole("region", { name: "Chat roles" })).toBeVisible();
}

/** The model button names the chat's model: its label is "Model: <name>. Change model or thinking". */
async function expectHeaderModel(page: Page, name: string): Promise<void> {
  await expect(headerModel(page)).toHaveAttribute(
    "aria-label",
    `Model: ${name}. Change model or thinking`,
    { timeout: 20_000 },
  );
}

/** The shell's background is the `--background` token, so the app's styles have loaded. */
async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((shell) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(shell).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return {
      normalizedBackground: normalize(background),
      normalizedToken: normalize(token),
      token,
    };
  });
  expect(colors.token).not.toBe("");
  expect(colors.normalizedBackground).toBe(colors.normalizedToken);
}

realTest(
  "Ctrl+P walks the role models smol, default, slow and back to smol; Shift+Ctrl+P walks back, and the model button shows each one",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    let dialog = await openModelDialog(page);
    await openRoles(dialog);

    // One model per role. Default is set before the others: as omp's hub does, setting it switches the chat to it.
    await dialog.getByRole("button", { name: "Choose a model for Fast" }).click();
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Fast now uses Claude Haiku 3.")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("button", { name: "Choose a model for Default" }).click();
    await dialog.getByRole("button", { name: FAKE_SONNET }).click();
    await expect(dialog.getByText("Default now uses Claude Sonnet 3.5.")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("button", { name: "Choose a model for Thinking" }).click();
    await dialog.getByRole("button", { name: FAKE_FABLE }).click();
    await expect(dialog.getByText("Thinking now uses Claude Fable 5.")).toBeVisible({
      timeout: 30_000,
    });

    // The chat starts on the Fast model: picking it from the list changes this chat only.
    dialog = await reopenModelDialog(page, dialog);
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Active: fake/claude-3-haiku-20240307")).toBeVisible({
      timeout: 20_000,
    });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expectHeaderModel(page, "Claude Haiku 3");

    // Ctrl+P: Fast, Default, Thinking, and back to Fast.
    await page.keyboard.press("Control+p");
    await expectHeaderModel(page, "Claude Sonnet 3.5");
    await page.keyboard.press("Control+p");
    await expectHeaderModel(page, "Claude Fable 5");
    await page.keyboard.press("Control+p");
    await expectHeaderModel(page, "Claude Haiku 3");

    // Shift+Ctrl+P walks back: Thinking, Default, Fast.
    await page.keyboard.press("Control+Shift+P");
    await expectHeaderModel(page, "Claude Fable 5");
    await page.keyboard.press("Control+Shift+P");
    await expectHeaderModel(page, "Claude Sonnet 3.5");
    await page.keyboard.press("Control+Shift+P");
    await expectHeaderModel(page, "Claude Haiku 3");

    // One step forward leaves the button naming Default, the model the screenshots show.
    await page.keyboard.press("Control+p");
    await expectHeaderModel(page, "Claude Sonnet 3.5");
    const toolbar = page.locator('[data-layout-area="composerToolbar"]');
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await toolbar.screenshot({ path: join(screenshots, "fix-2513-model-button-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await toolbar.screenshot({ path: join(screenshots, "fix-2513-model-button-dark.png") });

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await expect(headerModel(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await toolbar.screenshot({ path: join(screenshots, "fix-2513-model-button-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);
