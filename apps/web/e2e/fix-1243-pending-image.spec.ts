import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1243. A picture dropped onto the composer is attached in two steps: its chip shows at once, and the picture is
 * whole once omp's attachment store has answered. The answer is held here until the test releases it, so the picture is
 * still loading when a message is sent. The message must not go without the picture: it stays in the box, with one
 * sentence that says the picture is still loading, until the picture is attached.
 */

realTest.setTimeout(420_000);

const IMAGE = "photo-1243.png";
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const LOADING = "The image is still loading, so the message is not sent yet.";
const SEND_AT_ONCE = "sent at once, with a picture";
const QUEUED = "queued at once, with a picture";
const RUN = "stream_long_code please";
const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
/** A drop shows its chip after the file is read; the bound covers a slow read on a loaded machine. */
const CHIP = { timeout: 30_000 } as const;

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function afterThisTurn(page: Page): Locator {
  return page
    .getByRole("complementary", { name: "Queued messages" })
    .getByRole("region", { name: "After this turn" });
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

/**
 * Starts a chat and lets omp answer one message in it, so the chat's own draft has loaded before a picture is dropped.
 * A picture dropped while the draft is still loading is cleared when the draft arrives: that is a separate defect.
 */
async function openAnsweredChat(page: Page, box: Locator, count: number): Promise<void> {
  await sendPrompt(box, "ping before the picture");
  await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(count, {
    timeout: 90_000,
  });
}

/** The picture's upload answer, held back until `release`, then sent on the connection it came from. */
interface HeldUpload {
  released: boolean;
  answer?: { readonly message: string | Buffer; readonly send: (message: string | Buffer) => void };
  readonly release: () => void;
}

function newHeldUpload(): HeldUpload {
  const held: HeldUpload = {
    released: false,
    release: () => {
      held.released = true;
      if (held.answer !== undefined) held.answer.send(held.answer.message);
      held.answer = undefined;
    },
  };
  return held;
}

/**
 * Holds the answer to the picture's upload: the one call of the attachment store, on the connection that made it, with
 * the id the app gave it. Records every prompt the app sends to omp, in order.
 */
async function holdUploadAnswer(target: Page, held: HeldUpload, sent: string[]): Promise<void> {
  await target.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    let uploadId: string | undefined;
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (frame.type === "call" && frame.port === "A1.attachmentStore" && frame.method === "put") {
        uploadId = String(frame.id);
      }
      if (frame.type === "call" && frame.method === "send") sent.push(JSON.stringify(frame.args));
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (
        frame.type === "result" &&
        uploadId !== undefined &&
        String(frame.id) === uploadId &&
        !held.released
      ) {
        held.answer = { message, send: (answer) => ws.send(answer) };
        return;
      }
      ws.send(message);
    });
  });
}

/** The prompt sent for `text`, with its images, if the app sent one. */
function promptFor(sent: readonly string[], text: string): Record<string, unknown> | undefined {
  for (const args of sent) {
    const parsed = JSON.parse(args) as { command?: { type?: unknown; message?: unknown } };
    if (parsed.command?.type === "prompt" && parsed.command.message === text) {
      return parsed.command as Record<string, unknown>;
    }
  }
  return undefined;
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "a picture dropped and sent at once is not sent without it: the message waits in the box until the picture is attached",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const held = newHeldUpload();
    const sent: string[] = [];
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await holdUploadAnswer(target, held, sent);
      },
    });
    const box = await startChat(page);
    await openAnsweredChat(page, box, 1);
    await dropImage(box);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE, CHIP);
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toHaveCount(0);

    // The picture is still loading: the message is held, not sent.
    await box.fill(SEND_AT_ONCE);
    await box.press("Enter");
    await expect(page.getByText(LOADING)).toBeVisible();
    await expect(box).toHaveValue(SEND_AT_ONCE);
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1243-held-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1243-held-dark.png") });
    await setTheme(page, false);
    expect(promptFor(sent, SEND_AT_ONCE)).toBeUndefined();

    // The picture is attached: the same message now goes with it.
    held.release();
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible(CHIP);
    await expect(page.getByText(LOADING)).toHaveCount(0);
    await box.press("Enter");
    await expect(transcript(page).getByText(SEND_AT_ONCE, { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    expect(promptFor(sent, SEND_AT_ONCE)?.images).toHaveLength(1);
    await expect(box).toHaveValue("");
  },
);

realTest(
  "a message queued with Ctrl+Enter while a turn runs waits for its picture in the same way",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const held = newHeldUpload();
    const sent: string[] = [];
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await holdUploadAnswer(target, held, sent);
      },
    });
    const box = await startChat(page);
    await openAnsweredChat(page, box, 1);
    // stream_long_code keeps the turn open, so the Ctrl+Enter message is a queued one.
    await sendPrompt(box, RUN);
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 120_000,
    });
    await dropImage(box);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE, CHIP);

    await box.fill(QUEUED);
    await box.press("Control+Enter");
    await expect(page.getByText(LOADING)).toBeVisible();
    await expect(box).toHaveValue(QUEUED);
    await expect(afterThisTurn(page).getByText(QUEUED, { exact: true })).toHaveCount(0);
    // A picture that is loading does not hold back Stop: the turn can still be stopped.
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeEnabled();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1243-queue-held-light.png") });

    held.release();
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible(CHIP);
    await box.press("Control+Enter");
    await expect(afterThisTurn(page).getByText(QUEUED, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(box).toHaveValue("");
    expect(promptFor(sent, QUEUED)?.images).toHaveLength(1);
  },
);

realTest(
  "a picture dropped and sent at once on a phone-sized screen is held the same way",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const held = newHeldUpload();
    const sent: string[] = [];
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await holdUploadAnswer(target, held, sent);
      },
    });
    const box = await startChat(page);
    await openAnsweredChat(page, box, 1);
    // The screen narrows before the drop, and the chat answers once more at the new width: the picture is then held on a
    // phone-sized screen with the chat settled.
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await openAnsweredChat(page, box, 2);
    await dropImage(box);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE, CHIP);
    await box.fill(SEND_AT_ONCE);
    await box.press("Enter");
    await expect(page.getByText(LOADING)).toBeVisible();
    await expect(box).toHaveValue(SEND_AT_ONCE);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1243-held-narrow.png") });
    expect(promptFor(sent, SEND_AT_ONCE)).toBeUndefined();

    held.release();
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible(CHIP);
    await expect(page.getByText(LOADING)).toHaveCount(0);
  },
);
