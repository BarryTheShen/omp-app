import type { Locator, Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/**
 * Review of #1198 (PR #1223): a Stop's answer must land even when the chat has been left, and a restored image must
 * go to omp with its message. `stream_long_code` keeps the turn open while messages are queued.
 */

const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
const IMAGE = "photo-1198.png";
/** The name a restored image carries: omp sends only its bytes, so the app names it. */
const RESTORED_IMAGE = "queued-image-1";
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const RUN = "stream_long_code please";
const KEPT = "kept for the chat I left";
const WITH_IMAGE = "with a picture";
/** A drop shows its chip after the file is read; the bound covers a slow read on a loaded machine. */
const CHIP = { timeout: 30_000 } as const;

realTest.setTimeout(420_000);

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

function afterThisTurn(page: Page): Locator {
  return page
    .getByRole("complementary", { name: "Queued messages" })
    .getByRole("region", { name: "After this turn" });
}

/** Sends the long run and waits until the composer offers Stop. */
async function startLongRun(page: Page, box: Locator): Promise<Locator> {
  await sendPrompt(box, RUN);
  const stop = page.getByRole("button", { name: "Stop generating" });
  await expect(stop).toBeVisible({ timeout: 120_000 });
  return stop;
}

/** Queues a follow-up while the turn runs; the box is empty once it is queued. */
async function queueFollowUp(page: Page, box: Locator, text: string): Promise<void> {
  await box.fill(text);
  await box.press("Control+Enter");
  await expect(afterThisTurn(page).getByText(text, { exact: true })).toBeVisible();
  await expect(box).toHaveValue("");
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

/** The Stop's restoring command and its answer, the answer held back until the test releases it. */
interface HeldAnswer {
  callId?: string;
  answer?: string | Buffer;
  released: boolean;
  release: () => void;
}

function isRestoringCall(frame: Record<string, unknown>): boolean {
  if (frame.type !== "call" || frame.method !== "send") return false;
  const args = frame.args as { command?: { type?: unknown } } | undefined;
  return args?.command?.type === "abort_and_restore_queue";
}

async function holdRestoreAnswer(target: Page, held: HeldAnswer): Promise<void> {
  await target.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    held.release = () => {
      held.released = true;
      if (held.answer !== undefined) ws.send(held.answer);
      held.answer = undefined;
    };
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (isRestoringCall(frame)) held.callId = String(frame.id);
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (
        frame.type === "result" &&
        held.callId !== undefined &&
        String(frame.id) === held.callId &&
        !held.released
      ) {
        held.answer = message;
        return;
      }
      ws.send(message);
    });
  });
}

/** Records the arguments of every command the app sends to omp, in order. */
async function recordSends(target: Page, sent: string[]): Promise<void> {
  await target.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type === "call" && frame.method === "send") sent.push(JSON.stringify(frame.args));
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
}

function isPromptWithImage(args: string, text: string): boolean {
  const parsed = JSON.parse(args) as {
    command?: { type?: unknown; message?: unknown; images?: unknown };
  };
  return (
    parsed.command?.type === "prompt" &&
    parsed.command.message === text &&
    Array.isArray(parsed.command.images) &&
    parsed.command.images.length === 1
  );
}

realTest(
  "Stop followed at once by New chat keeps the stopped messages in the chat's own box",
  async ({ realApp }) => {
    const held: HeldAnswer = { released: false, release: () => undefined };
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await holdRestoreAnswer(target, held);
      },
    });
    const box = await startChat(page);
    const stop = await startLongRun(page, box);
    await queueFollowUp(page, box, KEPT);

    await stop.click();
    await expect.poll(() => held.answer !== undefined, { timeout: 30_000 }).toBe(true);
    // omp's answer is held: the chat is left before it arrives.
    await newChatButton(page).click();
    await expect(transcript(page).getByText(RUN, { exact: true })).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(composer(page)).toHaveValue("");
    held.release();

    await sessionList(page)
      .getByRole("option", { name: /stream_long_code please/ })
      .click();
    await expect(composer(page)).toHaveValue(KEPT, { timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a restored image is sent with its restored message, so omp's message has the image",
  async ({ realApp }) => {
    const sent: string[] = [];
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await recordSends(target, sent);
      },
    });
    const box = await startChat(page);
    const stop = await startLongRun(page, box);
    await dropImage(box);
    // The chip shows while the file is still being read; a message queued then goes without the image. Its Remove
    // button shows once the image is attached, and a queued message takes it from there.
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible(CHIP);
    await queueFollowUp(page, box, WITH_IMAGE);

    await stop.click();
    await expect(box).toHaveValue(WITH_IMAGE);
    await expect(page.locator(ATTACHMENTS)).toContainText(RESTORED_IMAGE, CHIP);

    await box.press("Enter");
    await expect.poll(() => sent.some((args) => isPromptWithImage(args, WITH_IMAGE))).toBe(true);
    expect(realApp.problems).toEqual([]);
  },
);
