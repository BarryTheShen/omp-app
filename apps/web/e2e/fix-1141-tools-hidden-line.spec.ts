import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1141. While Mod+Shift+O hides tool activity, the chat's footer shows one muted line that names the chord for showing it
 * again; pressing the chord again shows the cards and removes the line. The controls on the right of the footer do not
 * move. Real omp, with one seeded bash call in the chat.
 */

const LINE = "Tool activity is hidden. Press Ctrl+Shift+O to show it.";

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
  "the hidden-tools line appears with the chord, goes when tool activity is shown, and the footer controls do not move",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("Done listing.")).toBeVisible({ timeout: 60_000 });

    const card = page.getByTestId("tool-card-call-list");
    const toggle = page.getByRole("button", { name: "Expand all tool calls" });
    await expect(card).toBeVisible();
    const shownAt = await toggle.boundingBox();

    // The composer takes focus when a chat opens, and transcript chords stand down while it has it: click the transcript first.
    await page.getByText("Done listing.").click();
    await expect(page.getByRole("textbox", { name: "Message input" })).not.toBeFocused();
    await page.keyboard.press("Control+Shift+O");
    await expect(card).toHaveCount(0);
    await expect(page.getByText(LINE, { exact: true })).toBeVisible();

    // The line is read out politely, and the controls on the right are where they were.
    const notice = page.locator("[data-u1-tools-hidden-notice]");
    await expect(notice).toHaveAttribute("aria-live", "polite");
    const hiddenAt = await toggle.boundingBox();
    expect(hiddenAt?.x).toBeCloseTo(shownAt?.x ?? Number.NaN, 0);
    expect(hiddenAt?.y).toBeCloseTo(shownAt?.y ?? Number.NaN, 0);

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1141-tools-hidden-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1141-tools-hidden-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1141-tools-hidden-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Pressed again: the cards come back, and the line goes; the live region is empty again.
    await page.keyboard.press("Control+Shift+O");
    await expect(card).toBeVisible();
    await expect(page.getByText(LINE, { exact: true })).toHaveCount(0);
    await expect(notice).toBeEmpty();
  },
);
