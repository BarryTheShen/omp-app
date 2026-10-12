import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1238. The shortcut sheet's rebind field stored a chord with no key ("Ctrl+Shift+"), which no key press can
 * match. The sheet now refuses it in one sentence, and the row keeps the chord it had: Ctrl+Shift+O still hides tool
 * activity. Real omp, with one seeded bash call, so hiding tool activity is visible.
 */

const REFUSAL = "Add a key, for example Ctrl+K.";

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
  "a rebind to Ctrl+Shift+ with no key is refused in one sentence, and the old Ctrl+Shift+O still hides tool activity",
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

    // Ctrl and Shift with no key is refused: the sheet says so, and the row still shows its chord.
    await sheet.getByRole("button", { name: "Ctrl+Shift+O" }).click();
    const field = sheet.getByRole("textbox", { name: /^Rebind / });
    await expect(field).toHaveValue("Ctrl+Shift+O");
    await field.fill("Ctrl+Shift+");
    await field.press("Enter");
    await expect(sheet.getByRole("alert")).toHaveText(REFUSAL);
    await expect(sheet.getByRole("button", { name: "Ctrl+Shift+O" })).toBeVisible();

    await waitForFiniteAnimations(page);
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await page.screenshot({ path: join(screenshots, "fix-1238-refused-light.png") });

    const light = await page
      .locator("body")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    // The app follows the dark class set here; the background changes once its transition ends.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect
      .poll(() =>
        page.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor),
      )
      .not.toBe(light);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1238-refused-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expect(sheet.getByRole("alert")).toHaveText(REFUSAL);
    await page.screenshot({ path: join(screenshots, "fix-1238-refused-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // The old chord still works: Ctrl+Shift+O hides tool activity, and pressing it again shows it.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await page.getByText("Done listing.").click();
    await page.keyboard.press("Control+Shift+O");
    await expect(card).toHaveCount(0);
    await page.keyboard.press("Control+Shift+O");
    await expect(card).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);
