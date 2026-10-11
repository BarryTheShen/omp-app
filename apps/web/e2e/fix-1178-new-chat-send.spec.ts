/// <reference types="node" />
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

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
 * The new chat's `open` is held back on the wire, so the chat is still opening while the spec sends. The page still
 * shows the chat it had before; the server has already started omp for the new one.
 */
interface HeldOpen {
  /** Set by the spec just before New chat is clicked: the next `open` call is the new chat's. */
  armed: boolean;
  openCallId: string | undefined;
  /** Messages the page sent while the new chat's `open` was held. */
  readonly sendsWhileHeld: string[];
  readonly opened: Deferred;
  released: boolean;
  /** Delivers the held `open` result to the page, now or when it arrives. */
  release: () => void;
}

function newHeldOpen(): HeldOpen {
  return {
    armed: false,
    openCallId: undefined,
    sendsWhileHeld: [],
    opened: deferred(),
    released: false,
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
      if (
        frame.type === "call" &&
        frame.method === "send" &&
        hold.openCallId !== undefined &&
        !hold.released
      ) {
        hold.sendsWhileHeld.push(JSON.stringify(frame.args));
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

/** The session files in omp's bucket for the folder, with their text. */
async function sessionFiles(bucket: string): Promise<Map<string, string>> {
  const names = (await readdir(bucket)).filter((name) => name.endsWith(".jsonl"));
  const files = new Map<string, string>();
  for (const name of names) files.set(name, await readFile(join(bucket, name), "utf8"));
  return files;
}

/** Whether a session file that did not exist before holds the text: the new chat has the message. */
async function newChatHasText(
  bucket: string,
  before: ReadonlyMap<string, string>,
  text: string,
): Promise<boolean> {
  const now = await sessionFiles(bucket);
  return [...now].some(([name, body]) => !before.has(name) && body.includes(text));
}

const PREVIOUS = "first chat hello";
const NEW_CHAT = "hi there from the new chat";

realTest.setTimeout(420_000);

realTest(
  "a message sent right after New chat goes to the new chat, not to the chat before it",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const home = join(dirname(realApp.agentDir), "home");
    const bucket = join(realApp.agentDir, "sessions", sessionBucketName(realApp.folder, { home }));
    const hold = newHeldOpen();
    const page = await realApp.open({ beforeLoad: (page) => holdNewChatOpen(page, hold) });
    const composer = await startChat(page);

    await sendPrompt(composer, PREVIOUS);
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const before = await sessionFiles(bucket);
    expect(before.size).toBe(1);
    const [previousName, previousText] = [...before.entries()][0] ?? [];
    if (previousName === undefined || previousText === undefined)
      throw new Error("no session file for the previous chat");

    hold.armed = true;
    await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    await hold.opened.promise;
    // Sent at once, while the new chat is still opening. A fixed app holds this send until the new chat is on screen.
    await sendPrompt(composer, NEW_CHAT);
    await expect
      .poll(() => hold.sendsWhileHeld.some((args) => args.includes(NEW_CHAT)), { timeout: 3_000 })
      .toBe(true)
      .catch(() => undefined);
    hold.release();

    // The message is in the new chat's session file, and the chat on screen shows it.
    await expect
      .poll(() => newChatHasText(bucket, before, NEW_CHAT), { timeout: 60_000 })
      .toBe(true);
    await expect(
      page.getByRole("region", { name: "Conversation transcript" }).getByText(NEW_CHAT),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const after = await sessionFiles(bucket);
    const fresh = [...after.keys()].filter((name) => !before.has(name));
    expect(fresh).toHaveLength(1);
    expect(after.get(previousName)).toBe(previousText);

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1178-new-chat-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1178-new-chat-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // The previous chat's composer must be empty: the send took the text out of it. The chat list is on screen at
    // this width; a narrow layout hides it, and it does not come back by itself.
    await page.getByRole("option", { name: /first chat hello/ }).click();
    await expect(composer).toHaveValue("");

    // Back to the new chat, which shows the message, for the narrow capture.
    await page.getByRole("option", { name: /hi there from the new chat/ }).click();
    await expect(
      page.getByRole("region", { name: "Conversation transcript" }).getByText(NEW_CHAT),
    ).toBeVisible({ timeout: 30_000 });
    await page.setViewportSize({ width: 390, height: 844 });
    // The narrow layout reloads the open chat's view: the capture waits until its message and reply are shown.
    await expect(
      page.getByRole("region", { name: "Conversation transcript" }).getByText(NEW_CHAT),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1178-new-chat-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
