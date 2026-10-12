import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1142. The shortcut sheet's rebind field shows a chord the way the keyboard names it (Ctrl+Shift+O), and typing that
 * name rebinds the chord: the sheet reads it back the same, the new chord works, and the old one does nothing. Real omp,
 * with one seeded bash call, so hiding tool activity is visible.
 */

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

realTest.setTimeout(300_000);

realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        message: { role: "user", content: "list the files", timestamp: 1 },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-list",
              name: "bash",
              arguments: { command: "ls" },
            },
          ],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage: USAGE,
          stopReason: "toolUse",
          timestamp: 2,
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-list",
          toolName: "bash",
          content: [{ type: "text", text: "a.txt\nb.txt\n\nWall time: 0.01 seconds" }],
          details: { wallTimeMs: 10 },
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done listing." }],
          api: "openai-completions",
          provider: "fake",
          model: "fake-model",
          usage: USAGE,
          stopReason: "stop",
          timestamp: 4,
        },
      },
    ],
  },
});

realTest(
  "the rebind field shows Ctrl+Shift+O, typing Ctrl+Shift+J rebinds it, and the new chord hides tool activity",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("Done listing.")).toBeVisible({ timeout: 60_000 });
    const card = page.getByTestId("tool-card-call-list");
    await expect(card).toBeVisible();

    // The shortcut sheet opens from Ctrl+/ with focus on the transcript, not the message box.
    await page.getByText("Done listing.").click();
    await page.keyboard.press("Control+/");
    const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(sheet).toBeVisible();

    // The field shows the chord as the keyboard names it, not the stored form.
    await sheet.getByRole("button", { name: "Ctrl+Shift+O" }).click();
    const field = sheet.getByRole("textbox", { name: /^Rebind / });
    await expect(field).toHaveValue("Ctrl+Shift+O");

    // Typing the name rebinds the chord, and the sheet reads it back the same.
    await field.fill("Ctrl+Shift+J");
    await field.press("Enter");
    await expect(sheet.getByRole("button", { name: "Ctrl+Shift+J" })).toBeVisible();
    await expect(sheet).not.toContainText("Mod+");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1142-rebind-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1142-rebind-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1142-rebind-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // The new chord hides tool activity; the old one no longer does anything.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.getByText("Done listing.").click();
    await page.keyboard.press("Control+Shift+J");
    await expect(card).toHaveCount(0);
    await page.keyboard.press("Control+Shift+O");
    await expect(card).toHaveCount(0);
    await page.keyboard.press("Control+Shift+J");
    await expect(card).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
