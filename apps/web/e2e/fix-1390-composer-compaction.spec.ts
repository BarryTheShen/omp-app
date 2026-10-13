import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #1390: a `/compact soft` typed in the composer runs in the background. omp answers the prompt without a turn, and it
 * saves the compaction entry when the summary is done. The transcript shows the divider then, with no reload and no new
 * turn. The turn after it reads its prompt cache cold, so the cache row shows above that answer, below the divider.
 */

/** About 28,000 tokens. omp keeps the last 20,000 for a compaction, so the second turn leaves the first one to summarize. */
const LONG = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2_000);
/** On a turn whose prompt holds `cache_warm`, the fake model reads 800 tokens back from its prompt cache. */
const WARM = `cache_warm ${LONG}`;
/** On a turn whose prompt holds `cache_cold`, the fake model writes 800 tokens into its prompt cache again. */
const COLD = "cache_cold What did we decide?";

const DIVIDER = '[data-slot="p7-compaction-summary-row"]';
const MISS = "[data-p7-cache-miss-divider]";
const MESSAGE = '[data-slot="u1-message-row"]';
const SHOTS = join(screenshots, "fix-1390-composer-compaction");

/** The answers: the message rows that read "pong". */
function answers(page: Page): Locator {
  return page.locator(MESSAGE).filter({ hasText: "pong" });
}

/** The top edge of a row on the page: the rows are compared by where they sit. */
async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the row is not on the page");
  return box.y;
}

/** Brings the divider into view and takes the screen the rows read on. */
async function captureRows(page: Page, path: string): Promise<void> {
  await page.locator(DIVIDER).scrollIntoViewIfNeeded();
  await waitForFiniteAnimations(page);
  await page.screenshot({ animations: "disabled", path });
}

realTest(
  "a /compact soft typed in the composer shows its divider without a reload, and the cold turn after it shows the cache row above its answer",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    await mkdir(SHOTS, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, WARM);
    await expect(answers(page)).toHaveCount(1, { timeout: 90_000 });
    await sendPrompt(composer, WARM);
    await expect(answers(page)).toHaveCount(2, { timeout: 90_000 });

    await sendPrompt(composer, "/compact soft");
    // No reload and no new turn: the divider is the compaction omp saved when its summary was done.
    await expect(page.locator(DIVIDER)).toBeVisible({ timeout: 90_000 });
    await expect(page.locator(MISS)).toHaveCount(0);

    await sendPrompt(composer, COLD);
    await expect(answers(page)).toHaveCount(3, { timeout: 90_000 });
    await expect(page.locator(MISS)).toHaveCount(1);
    await expect(
      page
        .locator(MISS)
        .getByText("The prompt cache went cold, so omp processed 1,100 tokens again."),
    ).toBeVisible();
    // Read down the transcript: the warm answer, the divider, the cold prompt, the cache row, the cold answer.
    const warm = await topOf(answers(page).nth(1));
    const divider = await topOf(page.locator(DIVIDER));
    const prompt = await topOf(page.locator(MESSAGE).filter({ hasText: "What did we decide?" }));
    const miss = await topOf(page.locator(MISS));
    const cold = await topOf(answers(page).nth(2));
    expect(divider, "the divider comes after the warm answer").toBeGreaterThan(warm);
    expect(prompt, "the cold prompt comes after the divider").toBeGreaterThan(divider);
    expect(miss, "the cache row comes after the cold prompt").toBeGreaterThan(prompt);
    expect(cold, "the cold answer comes after its cache row").toBeGreaterThan(miss);
    await expect(page.getByText("Unable to render this omp message.")).toHaveCount(0);
    await captureRows(page, join(SHOTS, "light.png"));

    // The same rows come from history after a reload.
    await page.reload();
    await expect(page.locator(DIVIDER)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator(MISS)).toHaveCount(1);
    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator(MISS)).toHaveCount(1, { timeout: 60_000 });
    await captureRows(page, join(SHOTS, "dark.png"));
    await page.setViewportSize({ width: 390, height: 844 });
    await captureRows(page, join(SHOTS, "narrow.png"));
  },
);

realTest(
  "Compact now in the Context panel shows its divider without a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(SHOTS, { recursive: true });
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, WARM);
    await expect(answers(page)).toHaveCount(1, { timeout: 90_000 });
    await sendPrompt(composer, WARM);
    await expect(answers(page)).toHaveCount(2, { timeout: 90_000 });

    await page.getByRole("tab", { name: "Context" }).click();
    await page.getByRole("button", { name: "Compact now" }).click();
    await expect(page.getByText(/^Compacted [\d,]+ tokens\.$/)).toBeVisible({ timeout: 120_000 });
    // The panel's compaction is in the transcript with no reload and no new turn.
    await expect(page.locator(DIVIDER)).toBeVisible({ timeout: 60_000 });
    await captureRows(page, join(SHOTS, "context-panel-light.png"));
  },
);
