import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

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

/** Waits until the fake model's reply has arrived `count` times and the turn has ended. */
async function expectReplies(page: Page, count: number): Promise<void> {
  await expect(page.getByText("pong", { exact: true })).toHaveCount(count, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
}

realTest(
  "Up recalls the last prompt, Up again goes back, Down walks forward and restores the draft",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "hello probe");
    await expectReplies(page, 1);
    // The issue's steps as written, with one prompt: Up fills the composer, Up again stays at the
    // oldest prompt, and Down restores the empty draft.
    await composer.focus();
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("hello probe");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("hello probe");
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue("");
    await sendPrompt(composer, "second probe");
    await expectReplies(page, 2);

    await composer.focus();
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("second probe");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("hello probe");
    await expectTokenBackground(page);
    await page.screenshot({
      path: join(screenshots, "fix-history-light-recalled.png"),
      fullPage: true,
    });

    await composer.press("ArrowDown");
    await expect(composer).toHaveValue("second probe");
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue("");
  },
);

realTest(
  "a recalled prompt reads in dark and at 390 px without horizontal overflow",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    // System is the default theme, so a dark browser makes the app dark, as the theme spec checks.
    const page = await realApp.open({
      beforeLoad: (target) => target.emulateMedia({ colorScheme: "dark" }),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "hello probe");
    await expectReplies(page, 1);

    await composer.focus();
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("hello probe");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectTokenBackground(page);
    await page.screenshot({
      path: join(screenshots, "fix-history-dark-recalled.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(composer).toHaveValue("hello probe");
    const widths = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
    await page.screenshot({
      path: join(screenshots, "fix-history-narrow-recalled.png"),
      fullPage: true,
    });
  },
);

realTest(
  "inside a multi-line prompt, Down moves the caret until it is on the last line",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.fill("first line");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("second line");
    await composer.press("Enter");
    await expectReplies(page, 1);

    await composer.focus();
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("first line\nsecond line");
    // History restores the caret on the next animation frame; wait for that behavior before
    // pressing Down, or the test can move from the end of the prompt and browse history instead.
    await expect
      .poll(() => composer.evaluate((input: HTMLTextAreaElement) => input.selectionStart))
      .toBe(0);
    // The caret is on the first line, so Down is the caret's: the prompt stays as it is.
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue("first line\nsecond line");
    // On the last line, Down walks forward to the empty draft.
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue("");
  },
);

realTest(
  "with the emoji list open, Down moves the list and the recalled prompt stays",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    // ":sm" opens the emoji list, and Enter then chooses an emoji instead of sending (#818): close the list first.
    await composer.fill("pick :sm");
    await composer.press("Escape");
    await composer.press("Enter");
    await expectReplies(page, 1);

    await composer.focus();
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("pick :sm");
    await composer.press("End");
    await expect(page.getByRole("listbox", { name: "Emoji suggestions" })).toBeVisible();
    await composer.press("ArrowDown");
    await expect(composer).toHaveValue("pick :sm");
    await expect(page.getByRole("listbox", { name: "Emoji suggestions" })).toBeVisible();
  },
);

realTest(
  "a typed draft is still there after a reload, even while Up is recalling a prompt",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "hello probe");
    await expectReplies(page, 1);

    await composer.fill("my draft");
    // The draft autosaves every 10 s; wait past one save so the saved draft is "my draft".
    await page.waitForTimeout(11_000);
    await composer.press("Home");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue("hello probe");
    // A recalled prompt must not be saved over the draft, so wait past the next autosave too.
    await page.waitForTimeout(11_000);
    await page.reload();
    await expect(composer).toHaveValue("my draft", { timeout: 60_000 });
  },
);
