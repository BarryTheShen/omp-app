import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, type RealApp, realTest } from "./real-omp";
import { sendTyped } from "./share-stub";

/**
 * Issue #1525. Two tabs list the same chat, and only the first has it open. The first tab's typed `/session delete`
 * removes the chat, and the second tab's row goes without a reload: the server publishes the removal on the session file
 * stream, as the sidebar's own Delete does.
 */

realTest.use({ seedSessions: 1 });

const CHAT = "Seeded chat 1";

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

/** The question the typed `/session delete` asks first: its accessible name is "Delete chat". */
function deleteQuestion(page: Page): Locator {
  return page.getByRole("dialog", { name: "Delete chat" });
}

/** The session files on disk, anywhere under omp's sessions folder. No folder yet means no session. */
async function sessionFiles(realApp: RealApp): Promise<string[]> {
  try {
    const names = await readdir(join(realApp.agentDir, "sessions"), { recursive: true });
    return names.map(String).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

realTest(
  "#1525: a chat removed by a typed /session delete in one tab leaves the other tab's list without a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const first = await realApp.open();
    await expect(chatRow(first)).toBeVisible({ timeout: 60_000 });
    await chatRow(first).click();
    await expect(transcript(first).getByText(CHAT, { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    const [chatFile] = await sessionFiles(realApp);
    if (chatFile === undefined) throw new Error("the seeded chat has no session file");

    // The second tab lists the chat, and does not open it: no tab holds the chat, so the delete is not refused.
    const second = await realApp.open();
    await expect(chatRow(second)).toBeVisible({ timeout: 60_000 });

    // The first tab deletes the chat with the typed command and confirms.
    await sendTyped(
      first,
      first.getByRole("textbox", { name: "Message input" }),
      "/session delete",
    );
    await deleteQuestion(first).getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => sessionFiles(realApp), { timeout: 30_000 }).not.toContain(chatFile);

    // The second tab's row goes, with no reload of that tab.
    await expect(chatRow(second)).toHaveCount(0, { timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
