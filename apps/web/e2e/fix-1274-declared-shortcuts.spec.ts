import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1274: the chords the shortcut sheet lists do what the sheet says. Alt+M opens the chat's model and
 * thinking dialog from the message box; F2 on a chat in the session list opens its rename box; the sheet
 * lists Alt+K for the thinking cycle and no chord the browser keeps. Real omp, fake model.
 */

/** A shortcut row's title is read in full: a title cut short is wider inside its box than the box shows. */
async function expectReadInFull(title: Locator): Promise<void> {
  await expect(title).toBeVisible();
  expect(await title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
}

const AT = Date.UTC(2026, 8, 1, 12, 0, 0);
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// One exchange, so the chat is in the session list and opens with its message box.
realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Say hello." }],
          timestamp: AT,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello there." }],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage: USAGE,
          stopReason: "stop",
          timestamp: AT + 1_000,
        },
      },
    ],
  },
});

realTest(
  "Alt+M opens the model dialog from the message box, F2 renames the chat in the list, and the sheet lists what runs",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    const list = page.getByRole("listbox", { name: "Session list" });
    const chat = list.getByRole("option", { name: /Say hello\./ });
    await expect(chat).toBeVisible({ timeout: 60_000 });
    await chat.click();
    await expect(page.getByText("Hello there.")).toBeVisible({ timeout: 60_000 });

    // Alt+M from the message box opens the chat's model and thinking dialog.
    await page.getByRole("textbox", { name: "Message input" }).focus();
    await page.keyboard.press("Alt+M");
    const model = page.getByRole("dialog", { name: "Model and thinking" });
    await expect(model).toBeVisible();
    // Capture the loaded list: each model row has a "Set <model> as a role" button, and rows exist only once the catalog has loaded.
    await expect(model.getByRole("button", { name: /^Set .* as a role$/ }).first()).toBeVisible({
      timeout: 60_000,
    });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-model-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-model-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.keyboard.press("Escape");
    await expect(model).toBeHidden();

    // The sheet, opened from the transcript. Its search narrows it to one group at a time.
    await page.getByText("Hello there.").click();
    await page.keyboard.press("Control+/");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    const search = sheet.getByRole("textbox", { name: "Search shortcuts" });
    await expect(sheet).not.toContainText("Shift+Tab");
    await expect(sheet).not.toContainText("Browser reserved");
    await search.fill("session");
    await expect(sheet.getByRole("heading", { name: "Session list" })).toBeVisible();
    await expect(sheet).toContainText("Rename session");
    await expect(sheet).toContainText("F2");
    await expect(sheet).toContainText("Delete session without confirmation");
    await expectReadInFull(sheet.getByText("Delete session without confirmation", { exact: true }));
    await expect(sheet).not.toContainText("Toggle session");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-sheet-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expectReadInFull(sheet.getByText("Delete session without confirmation", { exact: true }));
    await page.screenshot({ path: join(screenshots, "fix-1274-sheet-session-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await search.fill("thinking");
    await expect(sheet).toContainText("Cycle thinking level");
    await expect(sheet).toContainText("Alt+K");
    await search.fill("model");
    await expect(sheet.getByRole("heading", { name: "Global" })).toBeVisible();
    await expect(sheet).toContainText("Open model selector");
    await expect(sheet).toContainText("Alt+M");
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-sheet-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // F2 on the chat that has focus in the list opens its rename box; Escape leaves the title as it was.
    await page.getByRole("textbox", { name: "Search sessions" }).focus();
    await page.keyboard.press("Tab");
    await expect(chat).toBeFocused();
    await page.keyboard.press("F2");
    const rename = page.getByRole("textbox", { name: /^Rename Say hello/ });
    await expect(rename).toBeFocused();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-rename-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-rename-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.keyboard.press("Escape");
    await expect(rename).toBeHidden();
    await expect(chat).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "at 390 px the model dialog, the rename box and the shortcut sheet open from the same keys",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    const list = page.getByRole("listbox", { name: "Session list" });
    const chat = list.getByRole("option", { name: /Say hello\./ });
    await expect(chat).toBeVisible({ timeout: 60_000 });
    await chat.click();
    await expect(page.getByText("Hello there.")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("textbox", { name: "Message input" }).focus();
    await page.keyboard.press("Alt+M");
    const model = page.getByRole("dialog", { name: "Model and thinking" });
    await expect(model).toBeVisible();
    await expect(model.getByRole("button", { name: /^Set .* as a role$/ }).first()).toBeVisible({
      timeout: 60_000,
    });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-model-narrow.png") });
    await page.keyboard.press("Escape");
    await expect(model).toBeHidden();

    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await page.getByRole("textbox", { name: "Search sessions" }).focus();
    await page.keyboard.press("Tab");
    await expect(chat).toBeFocused();
    await page.keyboard.press("F2");
    await expect(page.getByRole("textbox", { name: /^Rename Say hello/ })).toBeFocused();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-rename-narrow.png") });
    await page.keyboard.press("Escape");
    await expect(chat).toBeFocused();

    // The sessions drawer covers the page; close it first, or the sheet opens behind it. A tap beside the drawer closes it.
    await page
      .getByRole("button", { name: "Close open sidebar" })
      .click({ position: { x: 375, y: 400 } });
    await expect(page.getByRole("button", { name: "Close open sidebar" })).toHaveCount(0);
    await page.keyboard.press("Control+/");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await sheet.getByRole("textbox", { name: "Search shortcuts" }).fill("session");
    await expect(sheet.getByRole("heading", { name: "Session list" })).toBeVisible();
    await expectReadInFull(sheet.getByText("Delete session without confirmation", { exact: true }));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1274-sheet-narrow.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expectReadInFull(sheet.getByText("Delete session without confirmation", { exact: true }));
    await page.screenshot({ path: join(screenshots, "fix-1274-sheet-narrow-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    expect(realApp.problems).toEqual([]);
  },
);
