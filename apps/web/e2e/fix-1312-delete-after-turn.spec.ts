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
 * Issue #1312 on real omp. A chat whose turn runs is not open (a new chat is), and a Delete from its row is refused,
 * with a line that says to wait for the turn. When the turn ends, the line used to stay: nothing said the wait was over,
 * and the chat was not deleted. Now the line ends with the turn, and a second Delete deletes the chat. The chat's turn
 * is `run_queued_pair` (a bash that sleeps 20 s, then a write), answered by the fake model.
 */
const CHAT = "run_queued_pair";
const REFUSAL = "Wait for this chat's turn to finish, then delete it.";

/** The chat's row in the Session list. */
function rowOf(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" }).getByRole("option", {
    name: new RegExp(`^${CHAT}`),
  });
}

/** Opens the chat's More actions and chooses Delete, then confirms in the "Delete chat" dialog. */
async function deleteChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: `More actions for ${CHAT}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${CHAT}` })
    .getByRole("menuitem", { name: `Delete ${CHAT}` })
    .click();
  await page
    .getByRole("dialog", { name: "Delete chat" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}

realTest(
  "a delete refused while a background turn runs leaves no line once that turn ends, and a second Delete deletes the chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, CHAT);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 120_000,
    });
    // A new chat takes the view, so the running chat is not open.
    await startChat(page);
    const row = rowOf(page);
    // The running chat is listed once its session file is written; its actions exist only from then on.
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: `More actions for ${CHAT}` })).toBeVisible({
      timeout: 60_000,
    });

    await deleteChat(page);
    const refusal = page.getByRole("alert").filter({ hasText: REFUSAL });
    await expect(refusal).toBeVisible();
    await expect(refusal).toHaveCSS("color", /^(rgb|oklch)/);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-1312-refusal-light.png") });
    // The line is shown while the turn still runs, which is the state the issue describes.
    await expect(row.locator('[data-slot="r1-session-running"]')).toHaveCount(1);
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1312-refusal-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // The turn ends: the row stops showing Running. The wait is over, so the line about it goes too.
    await expect(row.locator('[data-slot="r1-session-running"]')).toHaveCount(0, {
      timeout: 120_000,
    });
    await expect(refusal).toHaveCount(0);

    // A second Delete deletes the chat.
    await deleteChat(page);
    await expect(rowOf(page)).toHaveCount(0, { timeout: 60_000 });

    // At 390 px the sidebar is a drawer: open it to read the list with no line in it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1312-after-narrow.png") });
  },
);
