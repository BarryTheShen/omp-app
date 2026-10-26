import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

/**
 * The wrapper every chat runs through (see real-omp.ts). It holds a new chat 4 s before it starts, so the New chat is
 * still starting when the file is dropped. A resumed chat starts at once.
 */
const delayDir = resolve(process.cwd(), "../../.data/fix-1114-new-chat");
mkdirSync(delayDir, { recursive: true });
const delayedOmp = join(delayDir, "omp-new-chat-delay.sh");
writeFileSync(
  delayedOmp,
  `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = "--resume" ]; then exec "$@"; fi
done
sleep 4
exec "$@"
`,
);
chmodSync(delayedOmp, 0o755);
realTest.use({ chatWrapper: delayedOmp });

const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
const IMAGE = "photo-1114.png";
/** A one-pixel PNG, so the dropped file is a real image. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const DESKTOP = { width: 1280, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
// The composer saves its draft after a short wait; the poll allows that plus the save.
const SAVED = { timeout: 45_000 } as const;

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

/** Opens the app in one theme, applied before the first paint. */
function themed(name: "light" | "dark") {
  return {
    beforeLoad: (target: Page) =>
      target.addInitScript(
        (value: string) => window.localStorage.setItem("omp-app.theme", value),
        name,
      ),
  };
}

/** Drops one picture onto the composer, as a person drops a file. No text is typed. */
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

/** The attachment names of the first draft in one of the app's draft folders, or null when none is stored. */
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

/** Starts a seeded chat (chat A), so there is a chat on screen when the New chat is clicked. */
async function seedChatA(app: Page): Promise<void> {
  const first = await startChat(app);
  await sendPrompt(first, "chat A seed");
  await expect(transcript(app).getByText("pong", { exact: true })).toBeVisible({
    timeout: 90_000,
  });
}

/**
 * Clicks New chat while chat A is on screen, and drops the picture before the new chat has opened: the New chat's omp is
 * still starting, and the transcript has not shown its empty chat yet.
 */
async function dropWhileNewChatStarts(app: Page): Promise<void> {
  await newChatButton(app).click();
  await expect(transcript(app).getByText("No messages yet.", { exact: true })).toHaveCount(0);
  await dispatchImageDrop(composer(app));
}

/** The new chat has opened: its empty transcript shows and its composer is there. */
async function expectNewChatOpen(app: Page): Promise<void> {
  await expect(transcript(app).getByText("No messages yet.", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(composer(app)).toBeVisible();
}

/**
 * #1114: a file dropped into the composer while a New chat is still starting belongs to that new chat. Before the fix it
 * was saved to the chat that was on screen before (chat A), and the new chat opened with no file.
 */
realTest(
  "a file dropped while a New chat is starting is in that new chat, and is there after leaving: light, then 390 px",
  async ({ realApp }) => {
    const app = await realApp.open(themed("light"));
    await app.setViewportSize(DESKTOP);
    await seedChatA(app);

    await dropWhileNewChatStarts(app);
    await expectNewChatOpen(app);
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 30_000 });
    await waitForFiniteAnimations(app);
    await app.screenshot({ path: join(screenshots, "fix-1114-new-chat-light.png") });

    // Leaving the new chat saves its file to the folder's new-chat draft; chat A never gets it.
    await sessionList(app)
      .getByRole("option", { name: /chat A seed/ })
      .click();
    await expect(transcript(app).getByText("chat A seed", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(app.locator(ATTACHMENTS)).toHaveCount(0);
    await expect
      .poll(() => storedAttachmentNames(realApp.appDataDir, "folders"), SAVED)
      .toEqual([IMAGE]);

    // Another New chat in this folder shows the file again.
    await newChatButton(app).click();
    await expectNewChatOpen(app);
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 30_000 });

    // The drawers opened at desktop stay open when the window narrows, so the phone view starts on a reload.
    await app.setViewportSize(PHONE);
    await app.reload();
    await expectNewChatOpen(app);
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 60_000 });
    const overflows = await app.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, "no sideways scroll at 390 px").toBe(false);
    await waitForFiniteAnimations(app);
    await app.screenshot({ path: join(screenshots, "fix-1114-new-chat-phone.png") });

    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a file dropped while a New chat is starting is in that new chat: dark",
  async ({ realApp }) => {
    const app = await realApp.open(themed("dark"));
    await app.setViewportSize(DESKTOP);
    await seedChatA(app);

    await dropWhileNewChatStarts(app);
    await expectNewChatOpen(app);
    await expect(app.locator("html")).toHaveClass(/dark/);
    await expect(app.locator(ATTACHMENTS)).toContainText(IMAGE, { timeout: 30_000 });
    await waitForFiniteAnimations(app);
    await app.screenshot({ path: join(screenshots, "fix-1114-new-chat-dark.png") });

    expect(realApp.problems).toEqual([]);
  },
);
