import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, sendPrompt, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1400. One chat is open in two tabs, and the first tab deletes it. The server refuses the delete, because the
 * second tab has the chat open, and the refusal shows in the first tab. The refusal must leave the first tab's chat as
 * it was: its next message is answered in the same chat, with no "No open thread" error.
 */

realTest.use({ seedSessions: 1 });

const CHAT = "Seeded chat 1";
const OTHER_TAB = "Another tab or window has this chat open. Close it there, then delete it again.";
/** The fake model answers a prompt with no keyword in it with this word. */
const ANSWER = "pong";

/** The chat's row in the session list: an option whose name starts with its title. */
function chatRow(page: Page): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(`^${CHAT}`) });
}

/** The conversation's region, where the chat's messages are read from. */
function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/** The composer the person types the next message into. */
function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

/** Deletes the chat from its row's More actions menu and confirms in the dialog, the way a person does. */
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
  "a delete refused because another tab has the chat open leaves this tab's chat answering",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const first = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(chatRow(first)).toBeVisible({ timeout: 60_000 });
    await chatRow(first).click();
    await expect(transcript(first).getByText(CHAT, { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });

    // The second tab opens the same chat from its list, so both tabs hold it.
    const second = await realApp.open();
    await expect(chatRow(second)).toBeVisible({ timeout: 60_000 });
    await chatRow(second).click();
    await expect(transcript(second).getByText(CHAT, { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });

    // The first tab asks to delete the chat: the server refuses, and the refusal shows in the first tab.
    await deleteChat(first);
    const shown = first.getByRole("alert").filter({ hasText: OTHER_TAB });
    await expect(shown).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1400-refused-delete-light.png"),
      fullPage: true,
    });

    // The refused tab still has its chat: the next message is answered in the same chat.
    await sendPrompt(composer(first), "Still there after the refused delete?");
    await expect(transcript(first).getByText(ANSWER, { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(first.getByRole("alert").filter({ hasText: "No open thread" })).toHaveCount(0);
    await expect(transcript(first).getByText("No messages yet.")).toHaveCount(0);
    // The second tab still shows the chat too.
    await expect(transcript(second).getByText(CHAT, { exact: true }).first()).toBeVisible();

    await first.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1400-refused-delete-dark.png"),
      fullPage: true,
    });
    await first.evaluate(() => document.documentElement.classList.remove("dark"));

    await first.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1400-refused-delete-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
