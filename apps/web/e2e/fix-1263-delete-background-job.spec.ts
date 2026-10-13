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
 * Issue #1263. The open chat starts a background job: `run_background_job` runs `sleep 120` in bash, and the turn ends
 * at once, so the chat stays busy while the job runs. The person deletes that open chat. The server refuses the delete,
 * the sentence shows in the sidebar, and the person stays in the chat. Before the fix the view left the chat first, so the
 * person landed in "No messages yet." with the sentence in the list, while the job kept running.
 */

const PROMPT = "run_background_job";
const SENTENCE = "Wait for this chat's turn to finish, then delete it.";

/** The chat's row in the session list. */
function sessionRow(page: Page): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(PROMPT) });
}

/** The conversation's region, where the chat's messages are read from. */
function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

realTest(
  "deleting the open chat while its background job runs shows the sentence, and the person stays in that chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page: Page = await realApp.open();
    const composer = await startChat(page);

    // The turn starts the job and ends at once; the chat is then listed, and its row shows Running while the job runs.
    await sendPrompt(composer, PROMPT);
    await expect(transcript(page).getByText("background jobs started")).toBeVisible({
      timeout: 120_000,
    });
    await expect(sessionRow(page)).toBeVisible({ timeout: 60_000 });
    await expect(sessionRow(page).getByTitle("Running", { exact: true })).toBeVisible();

    // Playwright's pointer actions wait on the running row, so each control is focused in the page and chosen with
    // Enter: the keys a person can use too.
    const focusThenEnter = async (locator: Locator): Promise<void> => {
      await locator.evaluate((element) => (element as HTMLElement).focus());
      await page.keyboard.press("Enter");
    };
    await focusThenEnter(page.getByRole("button", { name: `More actions for ${PROMPT}` }));
    await focusThenEnter(page.getByRole("menuitem", { name: `Delete ${PROMPT}` }));
    await focusThenEnter(
      page
        .getByRole("dialog", { name: "Delete chat" })
        .getByRole("button", { name: "Delete", exact: true }),
    );

    // The sentence shows, and the chat is still the one on screen: its prompt is there, and no new chat replaced it. The
    // job still runs, so the row still shows Running.
    const shown = page.getByRole("alert").filter({ hasText: SENTENCE });
    await expect(shown).toBeVisible({ timeout: 30_000 });
    await expect(transcript(page).getByText(PROMPT, { exact: true }).first()).toBeVisible();
    await expect(transcript(page).getByText("No messages yet.")).toHaveCount(0);
    await expect(sessionRow(page)).toBeVisible();
    await expect(sessionRow(page).getByTitle("Running", { exact: true })).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1263-background-light-r1.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1263-background-dark-r1.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(shown).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1263-background-narrow-r1.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
