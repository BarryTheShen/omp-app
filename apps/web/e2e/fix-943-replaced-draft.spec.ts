import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #943: text typed before a chat's saved draft has loaded wins, and nothing is sent that was not typed. The saved draft
 * it replaced is not lost: the composer offers to restore it, in plain words, and restoring puts it in front of the typed
 * text as a draft. The saved draft's read is held here, so the person types before it loads. Real omp; the stored draft
 * is read from the app's data folder.
 */

const PROMPT = "chat with a prompt";
const EARLIER = "earlier saved draft";
const TYPED = "typed before it loaded";
const OFFER = "Your earlier draft was replaced by what you typed before it loaded.";
const RESTORE = "Restore your earlier draft";
const NARROW = { width: 390, height: 844 } as const;
// The composer saves ten seconds after its last change; the poll allows that plus the save.
const SAVED = { timeout: 45_000 } as const;

realTest.setTimeout(300_000);

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function newChatButton(page: Page): Locator {
  return page.locator('[aria-label="Sessions"]').getByRole("button", { name: "New chat" }).first();
}

function offer(page: Page): Locator {
  return page.getByRole("status").filter({ hasText: OFFER });
}

/** Opens a new chat while `leaving` (the first prompt of the chat on screen) is shown. */
async function openNewChat(page: Page, leaving: string): Promise<void> {
  await newChatButton(page).click();
  await expect(transcript(page).getByText(leaving, { exact: true })).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

/** Opens a listed chat by its first prompt, and waits until its transcript is the one on screen. */
async function openListedChat(page: Page, firstPrompt: string): Promise<void> {
  await sessionList(page)
    .getByRole("option", { name: new RegExp(firstPrompt) })
    .click();
  await expect(transcript(page).getByText(firstPrompt, { exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

/** Whether a websocket message is the app's read of a chat's saved draft (the DraftStore `get` call). */
function isDraftRead(message: string | Buffer): boolean {
  try {
    const frame = JSON.parse(String(message)) as Record<string, unknown>;
    return frame.type === "call" && frame.port === "A1.draftStore" && frame.method === "get";
  } catch {
    // Non-JSON frames are forwarded unchanged.
    return false;
  }
}

/**
 * Holds the app's reads of a saved draft while the test holds them, so the test can type before the draft loads. Other
 * messages pass through unchanged; `release` sends the held reads on, in the order they were made.
 */
function draftReadHold() {
  let holding = false;
  const held: { readonly server: WebSocketRoute; readonly message: string | Buffer }[] = [];
  return {
    async install(page: Page): Promise<void> {
      await page.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          webSocket.onMessage((message) => {
            if (holding && isDraftRead(message)) {
              held.push({ server, message });
              return;
            }
            server.send(message);
          });
        },
      );
    },
    hold(): void {
      holding = true;
    },
    release(): void {
      holding = false;
      for (const { server, message } of held.splice(0)) server.send(message);
    },
  };
}

/** The text of the draft the app stored in one of its draft folders ("threads" or "folders"), or null when none is stored. */
async function storedDraftText(
  appDataDir: string,
  folder: "threads" | "folders",
): Promise<string | null> {
  const dir = join(appDataDir, "drafts", folder);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  for (const file of files) {
    const value: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "kind" in value &&
      value.kind === "draft" &&
      "text" in value &&
      typeof value.text === "string"
    ) {
      return value.text;
    }
  }
  return null;
}

realTest(
  "text typed before a saved draft loads is kept, and the saved draft is offered back, in plain words, until it is restored",
  async ({ realApp }) => {
    const reads = draftReadHold();
    const app = await realApp.open({ beforeLoad: reads.install });
    const first = await startChat(app);
    await sendPrompt(first, PROMPT);
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await composer(app).fill(EARLIER);
    await expect.poll(() => storedDraftText(realApp.appDataDir, "threads"), SAVED).toBe(EARLIER);

    // Leave the chat, then open it with its saved draft's read held: the composer is empty until the read is released.
    await openNewChat(app, PROMPT);
    reads.hold();
    await openListedChat(app, PROMPT);
    await expect(composer(app)).toHaveValue("");
    await composer(app).fill(TYPED);
    await expect(composer(app)).toHaveValue(TYPED);

    reads.release();
    await expect(offer(app)).toBeVisible({ timeout: 60_000 });
    // Typed text wins: the composer keeps it, and the saved draft is not put in front of it.
    await expect(composer(app)).toHaveValue(TYPED);
    await expect(offer(app).getByText(EARLIER, { exact: true })).toBeVisible();
    await expect(app.getByRole("button", { name: RESTORE })).toBeVisible();
    await expect(transcript(app).getByText(TYPED, { exact: true })).toHaveCount(0);

    await waitForFiniteAnimations(app);
    await app.screenshot({ path: join(screenshots, "fix-943-replaced-light.png"), fullPage: true });
    await app.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await expect(offer(app)).toBeVisible();
    await waitForFiniteAnimations(app);
    await app.screenshot({ path: join(screenshots, "fix-943-replaced-dark.png"), fullPage: true });
    await app.evaluate(() => document.documentElement.classList.remove("dark"));
    await app.setViewportSize(NARROW);
    await expect(offer(app)).toBeVisible();
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-943-replaced-narrow.png"),
      fullPage: true,
    });

    // Restoring puts the saved draft in front of the typed text, in the composer, and saves both. Nothing is sent.
    await app.getByRole("button", { name: RESTORE }).click();
    await expect(composer(app)).toHaveValue(`${EARLIER}\n\n${TYPED}`);
    await expect(offer(app)).toHaveCount(0);
    await expect
      .poll(() => storedDraftText(realApp.appDataDir, "threads"), SAVED)
      .toBe(`${EARLIER}\n\n${TYPED}`);
    await expect(transcript(app).getByText(TYPED, { exact: true })).toHaveCount(0);
    await expect(transcript(app).getByText("pong", { exact: true })).toHaveCount(1);
    expect(realApp.problems).toEqual([]);
  },
);
