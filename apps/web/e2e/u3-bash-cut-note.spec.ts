import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, openToolCard, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #881. A bash result of about 205 KB (5,000 rows) is shortened by the thread's history window
 * to its head and tail. The card used to show two notes with two buttons that both promised the rest:
 * "Showing the first 12 of 1,562 lines." with "Show all 1,562 lines", and "Showing the start and end
 * of 205 KB; 64 KB is shown." with "Load full output". Now one note says what the app holds, and
 * "Load full output" is the next step; "Show all" comes back once the full output is loaded.
 */
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 5,000 rows of 41 characters and a newline each: about 205 KB, as the issue's result. */
const ROWS = Array.from(
  { length: 5000 },
  (_, index) => `row ${String(index + 1).padStart(4, "0")} ${"x".repeat(32)}`,
).join("\n");

realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        message: { role: "user", content: "print the rows", timestamp: 1 },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-rows",
              name: "bash",
              arguments: { command: "seq -f 'row %04g' 5000" },
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
          toolCallId: "call-rows",
          toolName: "bash",
          content: [{ type: "text", text: `${ROWS}\n\nWall time: 0.42 seconds` }],
          details: { wallTimeMs: 420 },
          isError: false,
          timestamp: 3,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "All 5000 rows are printed." }],
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
  "a bash card the app holds in part says so once, with Load full output; Show all comes back when the full output is loaded",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("All 5000 rows are printed.")).toBeVisible({ timeout: 60_000 });
    await mkdir(screenshots, { recursive: true });
    const card = page.getByTestId("u3-bash-card").first();
    await openToolCard(card);
    const note = card.locator('[data-slot="u3-tool-card-cut"]');

    // Partial: one note says what the app holds; the full output is the next step.
    await expect(note).toHaveCount(1);
    const text = note.locator("span").first();
    await expect(text).toHaveText(
      /^Showing the first 12 lines of the [\d,]+ loaded; the app has loaded 64 KB of 205 KB\.$/,
    );
    const load = note.getByRole("button", { name: "Load full output" });
    await expect(load).toBeVisible();
    // The note comes before its button: on one line the note is to the left; a wrapped button sits below.
    const noteBox = await text.boundingBox();
    const loadBox = await load.boundingBox();
    if (noteBox === null || loadBox === null) throw new Error("the note or its button has no box");
    const noteMiddle = noteBox.y + noteBox.height / 2;
    const loadMiddle = loadBox.y + loadBox.height / 2;
    if (Math.abs(noteMiddle - loadMiddle) < 10) {
      expect(noteBox.x).toBeLessThan(loadBox.x);
    } else {
      expect(noteMiddle).toBeLessThan(loadMiddle);
    }
    // No second note, and no "Show all" that would show only the loaded lines.
    await expect(card.getByText(/^Showing the first 12 of /)).toHaveCount(0);
    await expect(card.getByRole("button", { name: /Show all/ })).toHaveCount(0);
    await expect(card.getByTestId("u3-bash-stdout")).toContainText("row 0001");
    await expect(card.getByTestId("u3-bash-stdout")).not.toContainText("row 0013");
    await card.screenshot({ path: join(screenshots, "u3-bash-cut-note-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await card.screenshot({ path: join(screenshots, "u3-bash-cut-note-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await card.screenshot({ path: join(screenshots, "u3-bash-cut-note-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Loading the full output replaces the note; the card's own preview and "Show all" come back.
    await load.click();
    await expect(note).toHaveCount(0, { timeout: 60_000 });
    await expect(
      card.getByText("Showing the first 12 of 5,000 lines.", { exact: true }),
    ).toBeVisible();
    await card.getByRole("button", { name: "Show all 5,000 lines" }).click();
    await expect(card.getByTestId("u3-bash-stdout")).toContainText("row 5000");
  },
);
