import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue 1424. After Stop all, a Tasks row read Running and lost its Stop control when omp's count of the jobs it stopped
 * differed from the running rows the card showed. `run_stale_background` starts three jobs: the first ends after four
 * seconds, so the wait card lists the other two as running; the third ends on its own after 25 seconds, before Stop all.
 * Stop all then stops the one job still running, so omp's count (1) differs from the card's rows (2). The rows keep
 * their Stop controls, and the card says their statuses may be out of date.
 */

realTest.setTimeout(420_000);

/** The Tasks row for one job, found by the words of its command. */
function rowOf(wait: Locator, words: string): Locator {
  return wait.locator("li").filter({ hasText: words });
}

/** One capture of the card in the given theme, after the page's transitions finish. The theme is light after it. */
async function capture(page: Page, card: Locator, name: string, dark: boolean): Promise<void> {
  await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
  await waitForFiniteAnimations(page);
  // Centred, so the chat's bottom bar cannot cover the card's last lines in the capture.
  await card.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await card.screenshot({ path: join(screenshots, name) });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

realTest(
  "a Stop all whose count differs from the card's rows keeps their Stop controls and says their statuses may be out of date",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 1000 });
    const composer = await startChat(page);
    await sendPrompt(composer, "run_stale_background");
    await expect(page.getByText("background jobs started")).toBeVisible({ timeout: 120_000 });
    await sendPrompt(composer, "wait_for_jobs");

    const wait = page.getByTestId("t5-wait-card");
    await expect(wait).toBeVisible({ timeout: 120_000 });
    await openToolCard(wait);
    await expect(wait.locator("li")).toHaveCount(3, { timeout: 120_000 });
    // The completion notice has a visible plain summary; omp's full message stays behind "Full message".
    // Its generated job id depends on launch order, so match the command label instead.
    await expect(
      page.locator('[data-slot="u1-custom-note-heading"]').filter({ hasText: "later-done" }),
    ).toBeVisible({ timeout: 180_000 });

    await wait.getByRole("button", { name: "Stop all background jobs" }).click();
    await expect(wait.getByRole("status")).toContainText("Stopped 1 background job", {
      timeout: 120_000,
    });

    const longRow = rowOf(wait, "long-job");
    const laterRow = rowOf(wait, "later-done");
    // The rows keep the status the call gave them, and their Stop controls, so they can still be stopped.
    await expect(longRow).toContainText("Running");
    await expect(laterRow).toContainText("Running");
    await expect(longRow.getByRole("button", { name: /^Stop background job / })).toBeVisible();
    await expect(laterRow.getByRole("button", { name: /^Stop background job / })).toBeVisible();
    await expect(wait).toContainText(
      "omp did not say which of these jobs it stopped, so their statuses may be out of date.",
    );

    await capture(page, wait, "fix-1424-stale-light.png", false);
    await capture(page, wait, "fix-1424-stale-dark.png", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, wait, "fix-1424-stale-narrow.png", false);

    expect(realApp.problems).toEqual([]);
  },
);
