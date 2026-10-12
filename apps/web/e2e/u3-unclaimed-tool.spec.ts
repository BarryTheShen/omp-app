import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  openToolCard,
  realTest,
  type SeedToolResult,
  screenshots,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #847. A tool call no card claims fell to the fallback card, which said "Finished" beside the
 * chip's "Complete", and showed its text three JSON levels deep under "content: array". Now the
 * status is said once, the text shows at once, and the arguments read as rows. This is a tool result
 * seeded into one real chat on real omp, shaped as omp sends it.
 */
const SAMPLES: readonly SeedToolResult[] = [
  {
    toolName: "some_unlisted_tool",
    args: { query: "fixture" },
    result: { content: [{ type: "text", text: "custom result text" }], details: {} },
    isError: false,
  },
];

realTest.use({ seedToolResults: { results: SAMPLES } });

realTest(
  "an unclaimed tool's text result shows at once, its arguments read as rows, and its status is said once",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("end of sample 0")).toBeVisible({ timeout: 60_000 });
    await mkdir(screenshots, { recursive: true });
    const row = page.locator('[data-slot="u1-message-row"][data-role="assistant"]').nth(0);
    const card = row.locator('[data-tool-name="some_unlisted_tool"]');
    await expect(card).toBeVisible();
    await openToolCard(card);

    // The status is said once: the chip says Complete, and no line repeats it.
    await expect(card.locator('[data-slot="u3-tool-card-status"]')).toHaveText("Complete");
    await expect(card.getByText("Finished", { exact: true })).toHaveCount(0);

    // The text result is on the page at once, and the arguments are rows.
    await expect(card.getByTestId("t7-fallback-text")).toBeVisible();
    await expect(card.getByTestId("t7-fallback-text")).toHaveText("custom result text");
    await expect(card.getByTestId("t7-fallback-arguments")).toContainText("query");
    await expect(card.getByTestId("t7-fallback-arguments")).toContainText("fixture");
    await expect(card.getByText("Arguments: object")).toHaveCount(0);
    await expect(card.getByText("content: array")).toHaveCount(0);
    await expect(card.getByText("details: object")).toHaveCount(0);
    await row.screenshot({ path: join(screenshots, "u3-unclaimed-tool-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await row.screenshot({ path: join(screenshots, "u3-unclaimed-tool-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await row.screenshot({ path: join(screenshots, "u3-unclaimed-tool-narrow.png") });
  },
);
