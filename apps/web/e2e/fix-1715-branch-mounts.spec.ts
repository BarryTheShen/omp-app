import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

function editor(page: Page) {
  return page.getByRole("region", { name: "Editing an earlier message" });
}

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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
}
async function composerAreaBounds(page: Page): Promise<{ top: number; height: number }> {
  const bounds = await page.locator('[data-shell-region="composer"]').boundingBox();
  if (bounds === null) throw new Error("The composer area is not visible.");
  return { top: bounds.y, height: bounds.height };
}
function expectComposerBoundsUnchanged(
  before: { readonly top: number; readonly height: number },
  after: { readonly top: number; readonly height: number },
): void {
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
}

async function openEarlierMessageSelector(page: Page): Promise<void> {
  const opener = page.getByRole("button", { name: "Edit an earlier message" });
  await expect(opener).toBeVisible({ timeout: 20_000 });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("option", { name: /count_reply first/ })).toBeVisible();
  await dialog.getByRole("option", { name: /count_reply first/ }).click();
  await dialog.getByRole("button", { name: "Choose" }).click();
}

realTest("mounts the earlier-message selector in a real chat", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(360_000);
  const page = await realApp.open();
  await page.setViewportSize({ width: 1280, height: 900 });
  const composer = await startChat(page);
  await sendPrompt(composer, "count_reply first");
  await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });

  await openEarlierMessageSelector(page);
  const editorInput = editor(page).getByRole("textbox", { name: "Edit message" });
  await expect(editorInput).toHaveValue("count_reply first");
  await editorInput.fill("count_reply second");
  await editorInput.press("Enter");
  await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });

  await expect(page.getByRole("option", { name: /count_reply second/ })).toBeVisible();

  await mkdir(screenshots, { recursive: true });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1715-branch-mounts-light.png") });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1715-branch-mounts-dark.png") });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1715-branch-mounts-narrow.png") });
  expect(realApp.problems).toEqual([]);
});
realTest("a running turn disables earlier-message editing", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(360_000);
  await mkdir(screenshots, { recursive: true });
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.setViewportSize({ width: 1280, height: 900 });
      await target.emulateMedia({ colorScheme: "light" });
      await target.addInitScript(() => {
        window.localStorage.setItem("omp-app.theme", "light");
      });
    },
  });
  const stop = page.getByRole("button", { name: "Stop generating" });
  try {
    const newChat = page
      .locator('[aria-label="Sessions"]')
      .getByRole("button", { name: "New chat" })
      .first();
    await expect(newChat).toBeVisible({ timeout: 60_000 });
    await newChat.click();
    // As `startChat`: the composer shows once the new chat's omp has started.
    const composer = page.getByRole("textbox", { name: "Message input" });
    await expect(composer).toBeVisible({ timeout: 120_000 });
    await sendPrompt(composer, "count_reply first");
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
    const selector = page.getByRole("button", { name: "Edit an earlier message" });
    await expect(selector).toBeEnabled();
    const settledWide = await composerAreaBounds(page);
    await sendPrompt(composer, "stream_held show the long block");
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-code-view]").first()).toBeVisible({ timeout: 120_000 });
    const reasonText = "Wait for this chat's turn to finish, then edit an earlier message.";
    const runningWide = await composerAreaBounds(page);
    expectComposerBoundsUnchanged(settledWide, runningWide);

    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await expect(selector).toHaveAttribute("aria-disabled", "true");
    await expect(selector).not.toHaveAttribute("disabled");
    await expect(selector).toHaveAttribute("title", reasonText);
    const descriptionId = await selector.getAttribute("aria-describedby");
    if (descriptionId === null)
      throw new Error("The running selector has no accessible description.");
    const description = page.locator(`[id="${descriptionId}"]`);
    await expect(description).toHaveText(reasonText);
    await expect(description).toHaveClass(/sr-only/);
    await expect(page.getByText("No earlier messages to edit.", { exact: true })).toHaveCount(0);
    await expectTokenBackground(page);
    await selector.focus();
    await expect(selector).toBeFocused();
    const selectorBounds = await selector.boundingBox();
    if (selectorBounds === null) throw new Error("The running selector is not visible.");
    await page.mouse.click(
      selectorBounds.x + selectorBounds.width / 2,
      selectorBounds.y + selectorBounds.height / 2,
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await composer.focus();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1715-running-selector-light.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(selector).toHaveAttribute("aria-disabled", "true");
    await expect(selector).not.toHaveAttribute("disabled");
    await expect(selector).toHaveAttribute("title", reasonText);
    await expect(description).toHaveText(reasonText);
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1715-running-selector-dark.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    const runningNarrow = await composerAreaBounds(page);
    await expect(selector).toHaveAttribute("aria-disabled", "true");
    await expect(selector).not.toHaveAttribute("disabled");
    await expect(selector).toHaveAttribute("title", reasonText);
    await expect(description).toHaveText(reasonText);
    await expectNoHorizontalOverflow(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1715-running-selector-narrow.png"),
      fullPage: true,
    });
    await writeFile(join(realApp.agentDir, "release-held-reply"), "");
    await expect(stop).toHaveCount(0, { timeout: 120_000 });
    await expect(selector).toBeEnabled();
    await expect(selector).not.toHaveAttribute("aria-disabled", "true");
    await expect(selector).not.toHaveAttribute("title");
    await expect(selector).not.toHaveAttribute("aria-describedby");
    const settledNarrow = await composerAreaBounds(page);
    expectComposerBoundsUnchanged(runningNarrow, settledNarrow);
    await expect(page.getByText("No earlier messages to edit.", { exact: true })).toHaveCount(0);
  } finally {
    try {
      await writeFile(join(realApp.agentDir, "release-held-reply"), "");
    } finally {
      await page.close();
    }
  }
  expect(realApp.problems).toEqual([]);
});
