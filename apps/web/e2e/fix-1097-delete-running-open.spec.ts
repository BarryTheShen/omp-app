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
 * Issue #1097. The open chat's turn runs (`run_queued_pair` runs `sleep 20` in bash, so each turn runs about twenty
 * seconds), and the person deletes that chat. The sentence shows in the sidebar, and the person stays in the chat.
 * Before the fix the view left the chat first, so the person landed in "No messages yet." with the sentence in the list,
 * while the chat kept running in the background.
 *
 * The chat is listed once its first turn has answered (omp writes its file then), so the first turn runs to the end
 * first; the second turn is the running one that the person deletes.
 */

const PROMPT = "run_queued_pair";
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
  "deleting the open chat while its turn runs shows the sentence, and the person stays in that chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page: Page = await realApp.open();
    const stop = page.getByRole("button", { name: "Stop generating" });
    const composer = await startChat(page);

    // The first turn runs to its end; the chat is then listed, with its title.
    await sendPrompt(composer, PROMPT);
    await expect(stop).toBeVisible({ timeout: 120_000 });
    await expect(stop).toBeHidden({ timeout: 120_000 });
    await expect(sessionRow(page)).toBeVisible({ timeout: 60_000 });

    // The second turn runs (about twenty seconds) while the person deletes the open chat.
    await sendPrompt(composer, PROMPT);
    await expect(stop).toBeVisible({ timeout: 120_000 });

    // Playwright's actionability waits on the sidebar row hold a pointer action until the turn ends, so each control is
    // focused in the page and chosen with Enter: the keys a person can use too.
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

    // The sentence shows, and the chat is still the one on screen: its prompt is there, and no new chat replaced it.
    const shown = page.getByRole("alert").filter({ hasText: SENTENCE });
    await expect(shown).toBeVisible({ timeout: 30_000 });
    await expect(transcript(page).getByText(PROMPT, { exact: true }).first()).toBeVisible();
    await expect(transcript(page).getByText("No messages yet.")).toHaveCount(0);
    await expect(sessionRow(page)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1097-running-light-r1.png"),
      fullPage: true,
    });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1097-running-dark-r1.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(shown).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1097-running-narrow-r1.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
