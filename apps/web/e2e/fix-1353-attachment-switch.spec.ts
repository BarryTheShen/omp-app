import { mkdir } from "node:fs/promises";
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
 * Issue #1353. A picture still loading from a chat's saved draft, when the person has moved on to another chat, was put
 * into that next chat: one attachment manager serves every chat, and the restore had no check that it was still wanted.
 */

realTest.setTimeout(300_000);

const IMAGE = "photo-1353.png";
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

function chatOption(page: Page, title: string): Locator {
  return sessionList(page).getByRole("option", { name: new RegExp(title) });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

/**
 * Waits until the page stops moving. The phone layout slides its side panels in over several frames, and a capture taken
 * during that slide shows them half way. Two polls in a row with the same element geometry count as settled.
 */
async function untilLayoutSettles(page: Page): Promise<void> {
  let previous = "";
  await expect
    .poll(
      async () => {
        const current = await page.evaluate(() =>
          Array.from(document.body.querySelectorAll("*"), (element) => {
            const box = element.getBoundingClientRect();
            return `${box.x},${box.y},${box.width},${box.height},${getComputedStyle(element).opacity}`;
          }).join(";"),
        );
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Drops one PNG onto the composer, as a person does. */
async function dropImage(box: Locator): Promise<void> {
  await box.evaluate(
    (input, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name: IMAGE, base64: PNG_BASE64 },
  );
}

/** A websocket frame as an object, or undefined for a frame that is not JSON. */
function frameOf(message: string | Buffer): Record<string, unknown> | undefined {
  try {
    return JSON.parse(String(message)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface HeldReads {
  /** Routes the page's websocket: every picture read the app makes is held back until `release` is called. */
  readonly beforeLoad: (page: Page) => Promise<void>;
  /** The number of picture reads the test is holding right now. */
  readonly heldCount: () => number;
  /** The number of draft saves the app has sent so far. */
  readonly draftSaves: () => number;
  /** Sends the held reads to the server, and every later read passes straight through. */
  readonly release: () => void;
}

function holdPictureReads(): HeldReads {
  let holding = true;
  let saves = 0;
  const held: Array<{ readonly server: WebSocketRoute; readonly message: string | Buffer }> = [];
  return {
    beforeLoad: async (page) => {
      await page.routeWebSocket(/\/ws/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
          const frame = frameOf(message);
          if (frame?.type === "call" && frame.port === "A1.draftStore" && frame.method === "save") {
            saves += 1;
          }
          if (
            holding &&
            frame?.type === "call" &&
            frame.port === "A1.attachmentStore" &&
            frame.method === "get"
          ) {
            held.push({ server, message });
            return;
          }
          server.send(message);
        });
        server.onMessage((message) => ws.send(message));
      });
    },
    heldCount: () => held.length,
    draftSaves: () => saves,
    release: () => {
      holding = false;
      for (const read of held.splice(0)) read.server.send(read.message);
    },
  };
}

realTest(
  "#1353: a picture still loading from a chat's draft is not put into the chat the person opens next",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const reads = holdPictureReads();
    const page = await realApp.open({
      beforeLoad: (target) =>
        target
          .addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"))
          .then(() => reads.beforeLoad(target)),
    });

    // Two chats, each with one exchange, so both are in the session list.
    const first = await startChat(page);
    await sendPrompt(first, "first chat");
    await expect(chatOption(page, "first chat")).toBeVisible({ timeout: 60_000 });
    const second = await startChat(page);
    await sendPrompt(second, "second chat");
    await expect(chatOption(page, "second chat")).toBeVisible({ timeout: 60_000 });

    // The first chat gets a picture that is not sent. The picture is saved with the chat's draft before the person
    // opens the second chat.
    await chatOption(page, "first chat").click();
    await expect(transcript(page).getByText("first chat", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    const savesBefore = reads.draftSaves();
    await dropImage(first);
    await expect(page.getByText(IMAGE, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect.poll(reads.draftSaves, { timeout: 30_000 }).toBeGreaterThan(savesBefore);
    await chatOption(page, "second chat").click();
    await expect(transcript(page).getByText("second chat", { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    // The first chat is opened again: its saved picture is read back, and that read is held here.
    await chatOption(page, "first chat").click();
    await expect.poll(reads.heldCount, { timeout: 60_000 }).toBeGreaterThan(0);

    // The person opens a new chat before the picture has loaded, and then the read goes through.
    const fresh = await startChat(page);
    reads.release();
    // A picture put in by mistake would show within a second or two of the answer.
    await page.waitForTimeout(3_000);

    // The picture belongs to the first chat: the second chat does not show it.
    await expect(page.getByText(IMAGE, { exact: true })).toHaveCount(0);
    await expect(fresh).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1353-second-chat-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await untilLayoutSettles(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1353-second-chat-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 720 });

    // The first chat still has its picture.
    await chatOption(page, "first chat").click();
    await expect(page.getByText(IMAGE, { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
