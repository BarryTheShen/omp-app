/// <reference types="node" />
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

const PREVIOUS = "first chat hello";
const SENT = "Summarize this";
const LARGE = Array.from({ length: 150 }, (_, index) => `pasted line ${index + 1}`).join("\n");
const CHOICE = "Pasted 150 lines. Where should they go?";
const CHIP = "Pasted text 1 (150 lines).txt";
const IMAGE = "photo-new-chat.png";
const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

realTest.setTimeout(420_000);

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

/**
 * The new chat's `open` is held back on the wire, so the chat is still opening while the spec pastes and sends. The
 * page shows the chat that is opening, and its composer takes what the person attaches and types.
 */
interface HeldOpen {
  /** Set by the spec just before New chat is clicked: the next `open` call is the new chat's. */
  armed: boolean;
  openCallId: string | undefined;
  released: boolean;
  readonly opened: Deferred;
  /** Delivers the held `open` result to the page, now or when it arrives. */
  release: () => void;
}

function newHeldOpen(): HeldOpen {
  return {
    armed: false,
    openCallId: undefined,
    released: false,
    opened: deferred(),
    release: () => undefined,
  };
}

async function holdNewChatOpen(page: Page, hold: HeldOpen): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    let heldResult: string | Buffer | undefined;
    hold.release = () => {
      hold.released = true;
      if (heldResult !== undefined) ws.send(heldResult);
      heldResult = undefined;
    };
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type === "call" && frame.method === "open" && hold.armed) {
        hold.armed = false;
        hold.openCallId = String(frame.id);
        hold.opened.resolve();
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (
        frame.type === "result" &&
        hold.openCallId !== undefined &&
        String(frame.id) === hold.openCallId &&
        !hold.released
      ) {
        heldResult = message;
        return;
      }
      ws.send(message);
    });
  });
}

/** Pastes plain text into the composer, the way a clipboard paste arrives in the browser. */
async function paste(composer: Locator, text: string): Promise<void> {
  await composer.evaluate((input, pasted) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData("text/plain", pasted);
    input.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dataTransfer }),
    );
  }, text);
}

/** Drops one picture onto the composer, as a person drops a file. */
async function dropImage(composer: Locator): Promise<void> {
  await composer.evaluate(
    (input, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name: IMAGE, base64: PNG_BASE64 },
  );
}

/** The session files in omp's bucket for the folder, with their text. */
async function sessionFiles(bucket: string): Promise<Map<string, string>> {
  const names = (await readdir(bucket)).filter((name) => name.endsWith(".jsonl"));
  const files = new Map<string, string>();
  for (const name of names) files.set(name, await readFile(join(bucket, name), "utf8"));
  return files;
}

/** The text of the session files that did not exist before the send: the new chat's file. */
async function freshText(bucket: string, before: Map<string, string>): Promise<string> {
  const after = await sessionFiles(bucket);
  return [...after.entries()]
    .filter(([name]) => !before.has(name))
    .map(([, text]) => text)
    .join("\n");
}

realTest(
  "a wrapped paste and a picture sent while a new chat opens are stored in that new chat's message",
  async ({ realApp }) => {
    const home = join(dirname(realApp.agentDir), "home");
    const bucket = join(realApp.agentDir, "sessions", sessionBucketName(realApp.folder, { home }));
    const hold = newHeldOpen();
    const page = await realApp.open({ beforeLoad: (target) => holdNewChatOpen(target, hold) });
    const composer = await startChat(page);

    await sendPrompt(composer, PREVIOUS);
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const before = await sessionFiles(bucket);

    // New chat is clicked and its open is held. The person then pastes, attaches and sends before the chat opens: the
    // send waits for that chat, and goes to it with the block and the picture the composer held when Enter was pressed.
    hold.armed = true;
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await hold.opened.promise;
    await paste(composer, LARGE);
    await expect(page.getByText(CHOICE)).toBeVisible();
    await page.getByRole("button", { name: "Attach as a wrapped block" }).click();
    await expect(page.getByText(CHIP)).toBeVisible();
    await dropImage(composer);
    await expect(page.locator(ATTACHMENTS).getByText(IMAGE)).toBeVisible();
    await composer.fill(SENT);
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await composer.press("Enter");
    // The new chat's open is answered only now: the held send then goes to that chat.
    hold.release();

    await expect.poll(() => freshText(bucket, before), { timeout: 90_000 }).toContain(SENT);
    const stored = await freshText(bucket, before);
    expect(stored).toContain("<attachment>");
    expect(stored).toContain("pasted line 150");
    expect(stored).toContain('"type":"image"');
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);
