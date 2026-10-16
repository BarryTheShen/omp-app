/// <reference types="node" />
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
 * Issue 1293. A bash card for a command omp moved to the background said "Running in the background" for good, and its
 * Stop could stop another job: omp numbers its jobs bg_1, bg_2, ... per process, and a new process starts again at bg_1.
 * `run_quick_background` ends its job after two seconds; `run_background_job` and `run_second_background` run for minutes.
 */

const DESKTOP = { width: 1280, height: 1000 } as const;
const NARROW = { width: 390, height: 844 } as const;
const RUNNING_NOTE = "Running in the background";

/** The bash card whose command contains `command`. */
function bashCard(page: Page, command: string): Locator {
  return page.getByTestId("u3-bash-card").filter({ hasText: command });
}

/** One capture in the given theme, with the page's transitions finished first. The theme is back to light after it. */
async function capture(page: Page, name: string, dark: boolean): Promise<void> {
  await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

realTest(
  "a background command that has finished says so: its card no longer says it runs, and offers no Stop",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await sendPrompt(composer, "run_quick_background");
    const card = bashCard(page, "sleep 2; echo quick-done");
    await expect(card).toBeVisible({ timeout: 120_000 });
    const notice = page
      .locator('[data-custom-type="async-result"]')
      .filter({ hasText: /sleep 2; echo quick-done finished · \d+ seconds?\./ })
      .first();
    await expect(notice).toBeVisible({ timeout: 120_000 });
    await openToolCard(card);
    await expect(card).toContainText("Background job bg_1 finished.");
    await expect(card).not.toContainText(RUNNING_NOTE);
    await expect(card.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);
    await capture(page, "fix-1293-finished-light.png", false);
    await capture(page, "fix-1293-finished-dark.png", true);
    await page.setViewportSize(NARROW);
    await card.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1293-finished-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "after omp restarts, an earlier background command says it no longer runs, and the new command's Stop stops only the new job",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await sendPrompt(composer, "run_background_job");
    const earlier = bashCard(page, "sleep 120; echo job-0");
    await expect(page.getByText("background jobs started")).toBeVisible({ timeout: 120_000 });
    await openToolCard(earlier);
    await expect(earlier).toContainText("Running in the background as job bg_1.");

    // The app restarts, so its omp process ends. The chat is opened again in a new process, which starts at bg_1 again.
    // The old tab cannot reach the stopped app: those connection errors are expected.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    await realApp.restartServer();
    const reopened = await realApp.open();
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /run_background_job/ })
      .click();
    const earlierAgain = bashCard(reopened, "sleep 120; echo job-0");
    await expect(earlierAgain).toBeVisible({ timeout: 120_000 });
    await openToolCard(earlierAgain);
    await expect(earlierAgain).toContainText("omp stopped before its result came back");
    await expect(earlierAgain).not.toContainText(RUNNING_NOTE);
    await expect(earlierAgain.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);

    // The new process starts its own job, bg_1: its card runs and can stop it; the earlier card is left as it is.
    const reopenedComposer = reopened.getByRole("textbox", { name: "Message input" });
    await sendPrompt(reopenedComposer, "run_second_background");
    const later = bashCard(reopened, "sleep 120; echo second-job");
    await expect(later).toBeVisible({ timeout: 120_000 });
    await openToolCard(later);
    await expect(later).toContainText("Running in the background as job bg_1.");
    await later.getByRole("button", { name: "Stop background job bg_1" }).click();
    await expect(later.getByRole("status")).toHaveText("Stopped background job bg_1.");
    await expect(earlierAgain).not.toContainText(RUNNING_NOTE);
    await expect(earlierAgain.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);
    await capture(reopened, "fix-1293-restart-light.png", false);
    await capture(reopened, "fix-1293-restart-dark.png", true);
    await reopened.setViewportSize(NARROW);
    await later.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(reopened);
    await reopened.screenshot({
      path: join(screenshots, "fix-1293-restart-narrow.png"),
      fullPage: true,
    });
  },
);

realTest(
  "after a page reload with the job still running, its card still says it runs and keeps its Stop",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    await sendPrompt(composer, "run_background_job");
    const card = bashCard(page, "sleep 120; echo job-0");
    await expect(page.getByText("background jobs started")).toBeVisible({ timeout: 120_000 });
    await openToolCard(card);
    await expect(card).toContainText("Running in the background as job bg_1.");

    // A plain reload: omp keeps running, so the job is still this chat's own and still running.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    await page.reload();
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /run_background_job/ })
      .click();
    const reloaded = bashCard(page, "sleep 120; echo job-0");
    await expect(reloaded).toBeVisible({ timeout: 120_000 });
    await openToolCard(reloaded);
    await expect(reloaded).toContainText("Running in the background as job bg_1.");
    const stop = reloaded.getByRole("button", { name: "Stop background job bg_1" });
    await expect(stop).toHaveCount(1);
    await stop.click();
    await expect(reloaded.getByRole("status")).toHaveText("Stopped background job bg_1.");
  },
);
