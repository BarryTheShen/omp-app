/// <reference types="node" />
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
 * Issue 1289. A background worker's notice showed omp's words for the model in the chat: "Resume your work using the
 * result below", a `write agent://` and a `history://` address, and a raw log path. The notice now names the worker
 * and how it ended, from the agents roster, and offers the worker's transcript. Issue 1489: a failed worker's line also
 * says why it failed, with the reason the server gives (omp's saved-request path is not in it).
 * (The task card above the notice shows its launch result, which is a separate surface, not this notice.)
 */

/** Words omp writes for the model, and a raw log path: none of them may be in the notice. */
const OMP_WORDS = ["Resume your work", "write agent://", "history://", "raw-http-request"];

/** omp's reason for the failing subagent, as the server gives it: the provider's words, once, with its type. */
const FAILED_LINE =
  "FailProbe failed: 400 fake provider failure for the failing subagent (type=invalid_request_error)";

realTest.setTimeout(300_000);

/** The notice that names one worker by its line. */
function noticeFor(page: Page, line: string): Locator {
  return page.locator('[data-slot="u1-custom-note"]').filter({ hasText: line });
}

/** One capture of the notice in the given theme, after the page's transitions finish. The theme is light after it. */
async function capture(page: Page, notice: Locator, name: string, dark: boolean): Promise<void> {
  await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
  await waitForFiniteAnimations(page);
  await notice.scrollIntoViewIfNeeded();
  await notice.screenshot({ path: join(screenshots, name) });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
}

realTest(
  "a failed background worker's notice names it as failed, offers its transcript, and shows none of omp's words",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_failing_subagent");

    const notice = noticeFor(page, FAILED_LINE);
    await expect(notice).toBeVisible({ timeout: 120_000 });
    // Checked while the transcript is closed: an open transcript is the worker's own conversation.
    for (const words of OMP_WORDS) await expect(notice).not.toContainText(words);
    const open = notice.getByRole("button", { name: "View transcript" });
    await expect(open).toBeVisible();
    // The outline variant has a border: the design system's styles are loaded before the captures.
    expect(await open.evaluate((element) => getComputedStyle(element).borderTopWidth)).not.toBe(
      "0px",
    );
    await capture(page, notice, "fix-1289-failed-light.png", false);

    await open.click();
    await expect(notice.locator('[data-slot="u1-custom-note-transcript"]')).toBeVisible({
      timeout: 120_000,
    });
    await expect(notice.getByRole("button", { name: "Hide transcript" })).toBeVisible();
    await capture(page, notice, "fix-1289-failed-transcript-light.png", false);
    await capture(page, notice, "fix-1289-failed-transcript-dark.png", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, notice, "fix-1289-failed-transcript-narrow.png", false);

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a background worker that answers in plain text has its notice name it as finished, with none of omp's words",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_quiet_subagent");

    const notice = noticeFor(page, "QuietProbe finished.");
    await expect(notice).toBeVisible({ timeout: 120_000 });
    for (const words of OMP_WORDS) await expect(notice).not.toContainText(words);
    await capture(page, notice, "fix-1289-finished-light.png", false);
    await capture(page, notice, "fix-1289-finished-dark.png", true);
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, notice, "fix-1289-finished-narrow.png", false);

    expect(realApp.problems).toEqual([]);
  },
);
