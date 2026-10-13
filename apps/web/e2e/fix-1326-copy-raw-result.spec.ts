import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REAL_TOOL_RESULTS } from "../src/registry/real-results";
import { expect, openToolCard, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1326. On a generic tool card, "Copy raw result" copied only the first 12 lines of the result (ending in
 * "…"), and its status still said "Copied raw output". Now it copies the whole result: the text that "Show more"
 * reveals in the Result block. The result is a recorded find call (real omp, shaped as omp sends it), seeded into
 * one real chat.
 */
function recorded(name: string) {
  const sample = REAL_TOOL_RESULTS.find((candidate) => candidate.name === name);
  if (sample === undefined) throw new Error(`no recorded result named "${name}"`);
  return sample;
}

realTest.use({
  seedToolResults: { results: [recorded("find: one hit with a snippet")] },
});

realTest(
  "Copy raw result copies the whole result, the text Show more reveals, not its first 12 lines",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("end of sample 0")).toBeVisible({ timeout: 60_000 });
    await mkdir(screenshots, { recursive: true });

    const row = page.locator('[data-slot="u1-message-row"][data-role="assistant"]').nth(0);
    const card = row.locator('[data-slot="u3-tool-card"]').first();
    await openToolCard(card);
    await card.getByText("Raw details", { exact: true }).click();
    const result = card.locator('[data-slot="u3-tool-card-result"]');

    // The Result block shows its first lines; Copy raw result is pressed while it does.
    await result.getByRole("button", { name: "Copy raw result" }).click();
    await expect(card.getByText("Copied raw output", { exact: true })).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());

    // Show more reveals the whole result, and the copy must be exactly that text.
    await card.getByRole("button", { name: "Show more" }).click();
    const whole = await result.locator("pre").textContent();
    expect(whole?.split("\n").length ?? 0).toBeGreaterThan(12);
    expect(copied).toBe(whole);

    // Each capture is taken once the app's styles have loaded: the Result block has its bordered, pre-wrapped text.
    const shownResult = result.locator("pre");
    await expect(shownResult).toHaveCSS("border-top-width", "1px");
    await expect(shownResult).toHaveCSS("white-space", "pre-wrap");
    await card.screenshot({ path: join(screenshots, "fix-1326-copy-raw-result-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expect(shownResult).toHaveCSS("border-top-width", "1px");
    await card.screenshot({ path: join(screenshots, "fix-1326-copy-raw-result-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 900 });
    await waitForFiniteAnimations(page);
    await expect(shownResult).toHaveCSS("border-top-width", "1px");
    await card.screenshot({ path: join(screenshots, "fix-1326-copy-raw-result-narrow.png") });
  },
);
