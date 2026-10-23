import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, type RealApp, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

const DELETED = "chat to delete";
const DELETED_TEXT = "unsent text of the deleted chat";
const SETTLED_TEXT = "text saved before the saves are held";

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function parseFrame(message: string | Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(message));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Drops the draft saves this page sends once `start` is called, so text typed after that stays unsent: this browser
 * keeps it, and the server never has it. `start` is called only after the chat has its own draft saved: a save that
 * never lands also holds up the chat's move to its own draft, so the hold must not begin before that move.
 */
function holdDraftSaves() {
  let active = false;
  return {
    start: (): void => {
      active = true;
    },
    install: (openedPage: Page): Promise<void> =>
      openedPage.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          webSocket.onMessage((message) => {
            const frame = parseFrame(message);
            if (
              active &&
              frame.type === "call" &&
              frame.port === "A1.draftStore" &&
              frame.method === "save"
            )
              return;
            server.send(message);
          });
          server.onMessage((message) => {
            webSocket.send(message);
          });
        },
      ),
  };
}

/** The texts of the chat copies this browser holds: a chat's unsent text, kept until the app saves it. */
async function chatCopyTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith("omp-app:u2:draft:thread:"))
      .map(([, raw]) => {
        const value = JSON.parse(raw) as { input?: { text?: unknown } };
        return typeof value.input?.text === "string" ? value.input.text : "";
      }),
  );
}

/** The texts of the chat drafts the app has saved in its data folder. */
async function savedChatDraftTexts(realApp: RealApp): Promise<string[]> {
  const path = join(realApp.appDataDir, "drafts", "threads");
  const names = await readdir(path).catch(() => []);
  const texts: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const saved = JSON.parse(await readFile(join(path, name), "utf8")) as {
      kind?: unknown;
      text?: unknown;
    };
    if (saved.kind === "draft" && typeof saved.text === "string") texts.push(saved.text);
  }
  return texts;
}

/** Deletes the chat from its row's More actions menu and confirms in the dialog, the way a person does. */
async function deleteChat(page: Page, chat: string): Promise<void> {
  await page.getByRole("button", { name: `More actions for ${chat}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${chat}` })
    .getByRole("menuitem", { name: `Delete ${chat}` })
    .click();
  await page
    .getByRole("dialog", { name: "Delete chat" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}

realTest("a deleted chat's unsent local copy is removed on the next load", async ({ realApp }) => {
  const hold = holdDraftSaves();
  const page = await realApp.open({ beforeLoad: hold.install });
  const doomed = await startChat(page);
  await sendPrompt(doomed, DELETED);
  await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
    timeout: 120_000,
  });
  // Text typed right after the answer belongs to the New chat until the chat has its own draft. Wait until the app
  // saves that draft, so the move is done, and only then hold the saves.
  await composer(page).fill(SETTLED_TEXT);
  await expect
    .poll(() => savedChatDraftTexts(realApp), { timeout: 120_000 })
    .toContain(SETTLED_TEXT);
  hold.start();
  await composer(page).fill(DELETED_TEXT);
  // The text is unsent: this browser holds it, and the server has not received it.
  await expect.poll(() => chatCopyTexts(page), { timeout: 60_000 }).toContain(DELETED_TEXT);

  await deleteChat(page, DELETED);
  // The chat is deleted in this tab, so its copy goes at once, before any reload.
  await expect.poll(() => chatCopyTexts(page), { timeout: 60_000 }).not.toContain(DELETED_TEXT);
  await page.reload();
  await expect(composer(page)).toBeVisible({ timeout: 120_000 });

  expect(await chatCopyTexts(page)).not.toContain(DELETED_TEXT);
  expect(realApp.problems).toEqual([]);
});
