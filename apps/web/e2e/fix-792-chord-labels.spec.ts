import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots } from "./real-omp";

const AT = Date.UTC(2026, 8, 1, 12, 0, 0);
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// One short exchange, so the chat is open and its features (the conversation tree among them) are mounted.
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
/** Waits until no finite animation is still running, so a capture shows the dialog settled, not mid-fade. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
}

realTest(
  "#792: the palette row and the shortcut sheet show each chord the way the keyboard names it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("Hello there.")).toBeVisible({ timeout: 60_000 });

    // The palette: the conversation tree's row shows its stored chord Mod+Shift+H as Ctrl+Shift+H on Linux.
    await page.getByRole("textbox", { name: "Message input" }).focus();
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette.getByRole("combobox", { name: "Search commands" }).fill("conversation tree");
    const row = palette.getByRole("option", { name: /Conversation tree/ });
    await expect(row).toContainText("Ctrl+Shift+H");
    await expect(row).not.toContainText("Mod+");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-792-palette-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-792-palette-narrow.png") });
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });

    // The shortcut sheet, opened from Mod+/ with focus on the transcript (not the message box).
    await page.getByText("Hello there.").click();
    await page.keyboard.press("Control+/");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet.getByRole("button", { name: "Ctrl+Shift+H" })).toBeVisible();
    await expect(sheet).not.toContainText("Mod+");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-792-sheet-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-792-sheet-narrow.png") });
    // Dark theme: the sheet, then the palette row, at full width.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-792-sheet-dark.png") });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.keyboard.press("Control+k");
    await palette.getByRole("combobox", { name: "Search commands" }).fill("conversation tree");
    await expect(row).toContainText("Ctrl+Shift+H");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-792-palette-dark.png") });
    expect(realApp.problems).toEqual([]);
  },
);
