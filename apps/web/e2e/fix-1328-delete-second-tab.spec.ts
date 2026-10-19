import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1328. One chat is open in two tabs. Deleting it from the first tab while the second holds it is refused and
 * keeps the first tab in the chat, where the app says that another tab has it open. Once the second tab leaves, deleting
 * the chat from the first tab clears that tab to the closed New conversation view.
 */

realTest.use({ seedSessions: 1 });

const CHAT = "Seeded chat 1";
const OTHER_TAB = "Another tab or window has this chat open. Close it there, then delete it again.";

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
  "deleting a chat another tab has open keeps this tab in the chat, and says the other tab has it open",
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

    // The first tab deletes the chat while the second tab still has it open.
    await deleteChat(first);
    const shown = first.getByRole("alert").filter({ hasText: OTHER_TAB });
    await expect(shown).toBeVisible({ timeout: 30_000 });
    // The first tab stays in the chat: its messages are there, and no new, empty chat replaced it.
    await expect(transcript(first).getByText(CHAT, { exact: true }).first()).toBeVisible();
    await expect(transcript(first).getByText("No messages yet.")).toHaveCount(0);
    await expect(chatRow(first)).toBeVisible();
    // The second tab still shows the chat.
    await expect(transcript(second).getByText(CHAT, { exact: true }).first()).toBeVisible();
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1328-second-tab-light.png"),
      fullPage: true,
    });

    await first.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1328-second-tab-dark.png"),
      fullPage: true,
    });
    await first.evaluate(() => document.documentElement.classList.remove("dark"));

    await first.setViewportSize({ width: 390, height: 844 });
    await first.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(shown).toBeVisible();
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1328-second-tab-narrow.png"),
      fullPage: true,
    });

    // The second tab leaves the chat by starting a new one. Its empty transcript shows once the new chat is open, and
    // only then does the second tab let go of the chat: the first tab's delete is refused until then.
    await startChat(second);
    await expect(transcript(second).getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });

    // Once the second tab leaves, the same delete succeeds and closes the first tab's view.
    await deleteChat(first);
    await expect(chatRow(first)).toHaveCount(0, { timeout: 30_000 });
    await expect(first.getByRole("heading", { name: "New conversation" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(first.getByText("Ready when you are")).toBeVisible();
    await expect(
      first.getByText("Choose a workspace folder and start a new session."),
    ).toBeVisible();
    await expect(first.getByText("Open a session to start composing.")).toBeVisible();
    await expect(first.getByRole("textbox", { name: "Message input" })).toHaveCount(0);
    await expect(first.getByRole("button", { name: /Edit message/i })).toHaveCount(0);
    await expect(first.getByRole("button", { name: /Regenerate/i })).toHaveCount(0);
    await expect(first.getByRole("alert").filter({ hasText: OTHER_TAB })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
