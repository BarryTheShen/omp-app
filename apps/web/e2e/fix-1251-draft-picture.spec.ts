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
 * Issue #1251. A picture still loading when the chat's saved draft loads was cleared by that load, so the send guard
 * of #1250 could not see it and a message went without it. The picture now stays in the box through the same chat's
 * draft load, and the message waits for it, as #1243 makes it wait. A picture still uploading when the person opens
 * another chat is dropped with the chat it was dropped in: its upload answering later adds nothing to the new chat.
 */

realTest.setTimeout(300_000);

const IMAGE = "photo-1251.png";
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const HELD = "sent once the picture is attached";
const NEW_CHAT = "sent in the new chat, with no picture";
const LOADING = "The image is still loading, so the message is not sent yet.";
const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
/** A drop shows its chip after the file is read; the bound covers a slow read on a loaded machine. */
const CHIP = { timeout: 30_000 } as const;

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
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

interface Holds {
  readonly beforeLoad: (page: Page) => Promise<void>;
  /** Lets the chat's saved draft load. */
  readonly releaseDraft: () => void;
  /** Answers the picture's upload. */
  readonly releaseUpload: () => void;
  /** Whether the answer to the saved-draft read has reached the page. */
  readonly draftLoaded: () => boolean;
  /** Whether the answer to the picture's upload has reached the page. */
  readonly uploadAnswered: () => boolean;
  /** The arguments of every call the app made to omp's `send`, in order. */
  readonly sent: () => readonly string[];
}

/**
 * Holds the chat's saved-draft read, and the answer to the picture's upload, on the one connection the app uses, so the
 * picture is still loading when the draft arrives. Records the prompts the app sends.
 */
function holdDraftAndUpload(): Holds {
  const sent: string[] = [];
  const draftReads = new Set<string>();
  const heldDraftReads: Array<{
    readonly server: WebSocketRoute;
    readonly message: string | Buffer;
  }> = [];
  let draftHeld = true;
  let draftLoaded = false;
  let uploadId: string | undefined;
  let uploadHeld = true;
  let uploadAnswered = false;
  let heldUploadAnswer:
    | { readonly ws: WebSocketRoute; readonly message: string | Buffer }
    | undefined;
  return {
    beforeLoad: async (page) => {
      await page.routeWebSocket(/\/ws/, (ws) => {
        const server = ws.connectToServer();
        ws.onMessage((message) => {
          const frame = frameOf(message);
          if (
            draftHeld &&
            frame?.type === "call" &&
            frame.port === "A1.draftStore" &&
            frame.method === "get"
          ) {
            draftReads.add(String(frame.id));
            heldDraftReads.push({ server, message });
            return;
          }
          if (
            frame?.type === "call" &&
            frame.port === "A1.attachmentStore" &&
            frame.method === "put"
          ) {
            uploadId = String(frame.id);
          }
          if (frame?.type === "call" && frame.method === "send")
            sent.push(JSON.stringify(frame.args));
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = frameOf(message);
          if (frame?.type === "result" && draftReads.has(String(frame.id))) draftLoaded = true;
          if (frame?.type === "result" && uploadId !== undefined && String(frame.id) === uploadId) {
            if (uploadHeld) {
              heldUploadAnswer = { ws, message };
              return;
            }
            uploadAnswered = true;
          }
          ws.send(message);
        });
      });
    },
    releaseDraft: () => {
      draftHeld = false;
      for (const read of heldDraftReads.splice(0)) read.server.send(read.message);
    },
    releaseUpload: () => {
      uploadHeld = false;
      if (heldUploadAnswer === undefined) return;
      uploadAnswered = true;
      heldUploadAnswer.ws.send(heldUploadAnswer.message);
      heldUploadAnswer = undefined;
    },
    draftLoaded: () => draftLoaded,
    uploadAnswered: () => uploadAnswered,
    sent: () => sent,
  };
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

realTest(
  "a picture still loading when the chat's draft loads is still in the box, and its message waits for it",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const holds = holdDraftAndUpload();
    const page = await realApp.open({ beforeLoad: holds.beforeLoad });
    const box = await startChat(page);
    // Dropped while the chat's draft is still loading, and its upload has not answered yet.
    await dropImage(box);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE, CHIP);

    holds.releaseDraft();
    await expect.poll(holds.draftLoaded, CHIP).toBe(true);
    await waitForFiniteAnimations(page);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE);

    // The draft has loaded and the picture is still loading: the message is held, not sent.
    await box.fill(HELD);
    await box.press("Enter");
    await expect(page.getByText(LOADING)).toBeVisible();
    await expect(box).toHaveValue(HELD);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1251-held-light.png") });
    await setTheme(page, true);
    await expect(page.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await page.screenshot({ path: join(screenshots, "fix-1251-held-dark.png") });
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await untilLayoutSettles(page);
    await waitForFiniteAnimations(page);
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(fits).toBe(true);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE);
    await expect(box).toHaveValue(HELD);
    await page.screenshot({ path: join(screenshots, "fix-1251-held-narrow.png") });
    expect(promptFor(holds.sent(), HELD)).toBeUndefined();

    // The picture is attached: the same message goes with it.
    holds.releaseUpload();
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible(CHIP);
    await expect(page.getByText(LOADING)).toHaveCount(0);
    await box.press("Enter");
    await expect(transcript(page).getByText(HELD, { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    expect(promptFor(holds.sent(), HELD)?.images).toHaveLength(1);
    await expect(box).toHaveValue("");
  },
);

realTest(
  "a picture still uploading when the person opens another chat is not in that chat, even when its upload answers later",
  async ({ realApp }) => {
    const holds = holdDraftAndUpload();
    const page = await realApp.open({ beforeLoad: holds.beforeLoad });
    holds.releaseDraft();
    const first = await startChat(page);
    await sendPrompt(first, "ping before the picture");
    await expect(transcript(page).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    // Dropped into this chat, and its upload is still running when the person opens another chat.
    await dropImage(first);
    await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE, CHIP);
    const second = await startChat(page);
    // The empty state shows once omp has started the new chat (thread.tsx: "Loading conversation…" until then). A busy
    // machine takes longer than the 5 s default to start it, so this waits for that state, bounded by a real omp start.
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(IMAGE, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toHaveCount(0);

    // The upload answers now: the picture does not come back into the new chat.
    holds.releaseUpload();
    await expect.poll(holds.uploadAnswered, CHIP).toBe(true);
    await waitForFiniteAnimations(page);
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toHaveCount(0);
    await expect(page.getByText(IMAGE, { exact: true })).toHaveCount(0);

    // A message sent in the new chat goes without the picture.
    await sendPrompt(second, NEW_CHAT);
    await expect(transcript(page).getByText(NEW_CHAT, { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    expect(promptFor(holds.sent(), NEW_CHAT)?.images ?? []).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);
