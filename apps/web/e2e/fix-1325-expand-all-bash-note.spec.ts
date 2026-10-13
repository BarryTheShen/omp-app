import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, openToolCard, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1325. A bash result of about 205 KB (5,000 rows) is shortened by the thread's history window to its
 * head and tail, so the card holds 64 KB of it. With "Expand all tool calls" on, the card shows every loaded
 * line, but its note still said "Showing the first 12 lines of the N loaded; …". Now, when the card shows every
 * loaded line, the note says so; collapsed, the note still says what the card shows.
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
  "with Expand all tool calls on, a cut bash output says every loaded line is shown; collapsed, it says the first 12",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("All 5000 rows are printed.")).toBeVisible({ timeout: 60_000 });
    await mkdir(screenshots, { recursive: true });

    const card = page.getByTestId("u3-bash-card").first();
    const note = card.locator('[data-slot="u3-tool-card-cut"] span').first();
    const load = card.getByRole("button", { name: "Load full output" });

    // Collapsed, the card shows the first 12 lines of what the app holds.
    await openToolCard(card);
    await expect(note).toHaveText(
      /^Showing the first 12 lines of the [\d,]+ loaded; the app has loaded 64 KB of 205 KB\.$/,
    );

    // Expand all tool calls opens the card with every loaded line, and the note says that is what it shows.
    await page.getByRole("button", { name: "Expand all tool calls", exact: true }).click();
    await expect(card.getByTestId("u3-bash-stdout")).toContainText("row 0013");
    await expect(note).toHaveText(
      /^Showing the [\d,]+ loaded lines; the app has loaded 64 KB of 205 KB\.$/,
    );
    await expect(card.getByText(/^Showing the first 12 lines/)).toHaveCount(0);
    await expect(load).toBeVisible();

    // Each capture is taken once the app's styles have loaded: the load button has its surface colour.
    await expect(load).toHaveCSS("background-color", /^(rgb|oklch)/);
    await card.screenshot({ path: join(screenshots, "fix-1325-expand-all-cut-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expect(load).toHaveCSS("background-color", /^(rgb|oklch)/);
    await card.screenshot({ path: join(screenshots, "fix-1325-expand-all-cut-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await expect(load).toHaveCSS("background-color", /^(rgb|oklch)/);
    await card.screenshot({ path: join(screenshots, "fix-1325-expand-all-cut-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Collapse all tool calls folds the card. Opened again, it shows the first 12 lines, and the note says so.
    await page.getByRole("button", { name: "Collapse all tool calls", exact: true }).click();
    await expect(card.locator('[data-slot="u3-tool-card-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await openToolCard(card);
    await expect(card.getByTestId("u3-bash-stdout")).not.toContainText("row 0013");
    await expect(note).toHaveText(
      /^Showing the first 12 lines of the [\d,]+ loaded; the app has loaded 64 KB of 205 KB\.$/,
    );
  },
);
