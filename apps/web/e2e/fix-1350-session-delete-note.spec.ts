import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, type RealApp, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";
import { sendTyped } from "./share-stub";

/**
 * Issue #1350. One chat is open in two tabs, and the first tab types `/session delete`. The server refuses before omp is
 * asked, because the other tab holds the chat. The first tab used to show omp's own sentence, with the file's path and
 * "ACP session/load". Now the header says why in plain words, with no path, and the chat stays where it is.
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
  "#1350: a typed /session delete that another tab blocks says why in plain words in the header, with no path, and keeps the chat",
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
    const [chatFile] = await sessionFiles(realApp);
    if (chatFile === undefined) throw new Error("the seeded chat has no session file");

    // The second tab opens the same chat from its list, so both tabs hold it.
    const second = await realApp.open();
    await expect(chatRow(second)).toBeVisible({ timeout: 60_000 });
    await chatRow(second).click();
    await expect(transcript(second).getByText(CHAT, { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });

    // The first tab types the command and confirms. omp is not asked: the server refuses while the other tab holds it.
    await sendTyped(
      first,
      first.getByRole("textbox", { name: "Message input" }),
      "/session delete",
    );
    await deleteQuestion(first).getByRole("button", { name: "Delete", exact: true }).click();

    const note = first.getByRole("status").filter({ hasText: OTHER_TAB });
    await expect(note).toBeVisible({ timeout: 30_000 });
    // In plain words: no file path, and no ACP wording, anywhere on the page. The refusal is not an alert.
    await expect(first.getByText(/Session deleted:|session\/load|\.jsonl/)).toHaveCount(0);
    await expect(first.getByRole("alert").filter({ hasText: OTHER_TAB })).toHaveCount(0);
    // The chat stays: its messages, its row, its file, and the second tab's view of it.
    await expect(transcript(first).getByText(CHAT, { exact: true }).first()).toBeVisible();
    await expect(chatRow(first)).toBeVisible();
    expect(await sessionFiles(realApp)).toContain(chatFile);
    await expect(transcript(second).getByText(CHAT, { exact: true }).first()).toBeVisible();

    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1350-session-note-light.png"),
      fullPage: true,
    });

    await first.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1350-session-note-dark.png"),
      fullPage: true,
    });
    await first.evaluate(() => document.documentElement.classList.remove("dark"));

    await first.setViewportSize({ width: 390, height: 844 });
    await expect(note).toBeVisible();
    await waitForFiniteAnimations(first);
    await first.screenshot({
      path: join(screenshots, "fix-1350-session-note-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
