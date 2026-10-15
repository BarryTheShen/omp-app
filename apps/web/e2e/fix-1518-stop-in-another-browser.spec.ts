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
 * Issue 1518. A background job's stop was kept only by the browser that made it, so another browser still showed the
 * job as running. The server now keeps omp's confirmed stop for the chat, and a second browser (its own storage) that
 * opens the chat reads the job as stopped. `run_background_job` starts one job that runs for minutes.
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
  "a job stopped in one browser reads as stopped in another browser that opens the same chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const first = await realApp.open();
    await first.setViewportSize(DESKTOP);
    const composer = await startChat(first);
    await sendPrompt(composer, "run_background_job");
    const stopper = bashCard(first, "sleep 120; echo job-0");
    await expect(first.getByText("background jobs started")).toBeVisible({ timeout: 120_000 });
    await openToolCard(stopper);
    await expect(stopper).toContainText("Running in the background as job bg_1.");
    await stopper.getByRole("button", { name: "Stop background job bg_1" }).click();
    await expect(stopper.getByRole("status")).toHaveText("Stopped background job bg_1.");

    // A second browser has its own storage, so only the server can say the job was stopped.
    const second = await realApp.open();
    await second.setViewportSize(DESKTOP);
    await second
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /run_background_job/ })
      .click();
    const other = bashCard(second, "sleep 120; echo job-0");
    await expect(other).toBeVisible({ timeout: 120_000 });
    await openToolCard(other);
    await expect(other.getByRole("status")).toHaveText("Stopped background job bg_1.");
    await expect(other).not.toContainText(RUNNING_NOTE);
    await expect(other.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);
    await capture(second, "fix-1518-other-browser-light.png", false);
    await capture(second, "fix-1518-other-browser-dark.png", true);
    await second.setViewportSize(NARROW);
    await other.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(second);
    await second.screenshot({
      path: join(screenshots, "fix-1518-other-browser-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a stop kept for an earlier job does not reach a later job with the same id: after omp restarts, the new bg_1 keeps its Stop",
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
    await earlier.getByRole("button", { name: "Stop background job bg_1" }).click();
    await expect(earlier.getByRole("status")).toHaveText("Stopped background job bg_1.");

    // The app restarts, so the chat's omp process ends; the chat opens in a new process, which starts its jobs at bg_1
    // again. The old tab cannot reach the stopped app: those connection errors are expected.
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
    await expect(earlierAgain.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);

    // The new process runs its own job, bg_1. Its card is running and keeps its Stop: the stop made for the earlier job
    // is not this job's.
    const reopenedComposer = reopened.getByRole("textbox", { name: "Message input" });
    await sendPrompt(reopenedComposer, "run_second_background");
    const later = bashCard(reopened, "sleep 120; echo second-job");
    await expect(later).toBeVisible({ timeout: 120_000 });
    await openToolCard(later);
    await expect(later).toContainText("Running in the background as job bg_1.");
    await expect(later).not.toContainText("Stopped background job");
    const laterStop = later.getByRole("button", { name: "Stop background job bg_1" });
    await expect(laterStop).toHaveCount(1);
    await later.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await capture(reopened, "fix-1518-restart-light.png", false);
    await capture(reopened, "fix-1518-restart-dark.png", true);
    await reopened.setViewportSize(NARROW);
    await later.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(reopened);
    await reopened.screenshot({
      path: join(screenshots, "fix-1518-restart-narrow.png"),
      fullPage: true,
    });

    // The new job's own Stop still works, and then reads as stopped; the earlier card is left as it was.
    await laterStop.click();
    await expect(later.getByRole("status")).toHaveText("Stopped background job bg_1.");
    await expect(earlierAgain.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);
  },
);
