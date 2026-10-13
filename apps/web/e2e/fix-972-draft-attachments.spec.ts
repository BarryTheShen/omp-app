import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * #972: an image dropped into the composer with no text is part of the chat's draft. Leaving the chat saves it, and
 * opening the chat again brings it back, after a reload too. Real omp; the saved draft is read from the app's data
 * folder, so the test sees the server's copy and not only what the page remembers.
 */

const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
const IMAGE = "photo-972.png";
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
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

/**
 * Drops one image onto the composer, as a person does. No text is typed. Returns once the picture is attached: a
 * picture still uploading is dropped when its chat is left, so a test must not leave the chat before this returns.
 */
async function dropImage(page: Page, target: Locator): Promise<void> {
  await dispatchImageDrop(target);
  await expect(page.locator(ATTACHMENTS)).toContainText(IMAGE);
  // A picture that is still uploading has no Remove button; an attached picture has one.
  await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible({
    timeout: 60_000,
  });
}

/** Dispatches the drop of one image onto the composer; the composer decides whether to take it. */
async function dispatchImageDrop(target: Locator): Promise<void> {
  await target.evaluate(
    (input, { name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name: IMAGE, base64: PNG_BASE64 },
  );
}

/** The attachment names of the draft the app stored in one of its draft folders, or null when none is stored. */
async function storedAttachmentNames(
  appDataDir: string,
  folder: "threads" | "folders",
): Promise<string[] | null> {
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
      "attachments" in value &&
      Array.isArray(value.attachments)
    ) {
      return value.attachments.map((ref: { name?: unknown }) => String(ref.name));
    }
  }
  return null;
}

/** A websocket frame the test reads: the call or result it needs, with the rest passed through. */
const WireFrame = z
  .object({
    type: z.string(),
    id: z.union([z.string(), z.number()]).optional(),
    port: z.string().optional(),
    method: z.string().optional(),
    args: z.unknown().optional(),
  })
  .passthrough();
/** The arguments of a session open that starts a new chat. */
const NewChatStart = z.object({ start: z.literal("new") }).passthrough();

function parseWireFrame(message: string | Buffer): z.infer<typeof WireFrame> | null {
  try {
    const parsed = WireFrame.safeParse(JSON.parse(String(message)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Counts the answers to New chat starts that reach the page, and passes every frame on unchanged. The page binds a
 * new chat's draft after it reads that answer, so a test that drops a file into a new chat waits for the count to rise.
 */
function watchNewChatAnswers(openedPage: Page, answers: { count: number }): Promise<void> {
  const starts = new Set<string>();
  return openedPage.routeWebSocket(
    () => true,
    (webSocket) => {
      const server = webSocket.connectToServer();
      webSocket.onMessage((message) => {
        const frame = parseWireFrame(message);
        if (
          frame !== null &&
          frame.type === "call" &&
          frame.port === "A0.rpcSession" &&
          frame.method === "open" &&
          NewChatStart.safeParse(frame.args).success
        ) {
          starts.add(String(frame.id));
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = parseWireFrame(message);
        if (frame !== null && frame.type === "result" && starts.has(String(frame.id))) {
          answers.count += 1;
        }
        webSocket.send(message);
      });
    },
  );
}

realTest(
  "an image dropped into a new chat with no text is saved when the person leaves, and is back after a reload",
  async ({ realApp }) => {
    const answers = { count: 0 };
    const app = await realApp.open({
      beforeLoad: (openedPage) => watchNewChatAnswers(openedPage, answers),
    });
    const first = await startChat(app);
    await sendPrompt(first, "chat A seed");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });

    const answersBefore = answers.count;
    await openNewChat(app, "chat A seed");
    // The new chat's answer must reach the page, and its empty transcript must show, before the file is dropped: a
    // drop earlier than that can land in the chat that was on screen before.
    await expect.poll(() => answers.count).toBeGreaterThan(answersBefore);
    await expect(transcript(app).getByText("No messages yet.", { exact: true })).toBeVisible();
    await dropImage(app, composer(app));

    // Leaving the new chat saves its draft: the image is in the stored draft, not only on screen.
    await openListedChat(app, "chat A seed");
    await expect(app.locator(ATTACHMENTS)).toHaveCount(0);
    await expect
      .poll(() => storedAttachmentNames(realApp.appDataDir, "folders"), SAVED)
      .toEqual([IMAGE]);

    await openNewChat(app, "chat A seed");
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 30_000 });
    await expect(composer(app)).toHaveValue("");

    // A reload reopens this new chat, and the image is still there.
    await app.reload();
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 60_000 });
    await expect(composer(app)).toHaveValue("");
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-972-attachment-light.png"),
      fullPage: true,
    });

    await app.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator("body")).toHaveCSS("background-color", /^(rgb|oklch)/);
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-972-attachment-dark.png"),
      fullPage: true,
    });
    await app.evaluate(() => document.documentElement.classList.remove("dark"));

    await app.setViewportSize(NARROW);
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE);
    await waitForFiniteAnimations(app);
    await app.screenshot({
      path: join(screenshots, "fix-972-attachment-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "an image dropped into a chat that has messages is back when that chat is opened again",
  async ({ realApp }) => {
    const app = await realApp.open();
    const first = await startChat(app);
    await sendPrompt(first, "chat A seed");
    await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await dropImage(app, composer(app));

    // Another chat shows none of this chat's image; the image is saved to this chat's draft.
    await openNewChat(app, "chat A seed");
    await expect(app.locator(ATTACHMENTS)).toHaveCount(0);
    await expect
      .poll(() => storedAttachmentNames(realApp.appDataDir, "threads"), SAVED)
      .toEqual([IMAGE]);

    await openListedChat(app, "chat A seed");
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
