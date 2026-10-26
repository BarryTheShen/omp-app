import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
const SAVED = { timeout: 45_000 } as const;
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function addFile(page: Page, composer: Locator, name: string): Promise<void> {
  await composer.evaluate((input, fileName) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["attachment body"], fileName, { type: "text/plain" }));
    input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, name);
  await expect(page.locator(ATTACHMENTS)).toContainText(name);
}

/**
 * Drops one picture onto the composer. A picture is sent as a picture and stays a chip when its send fails; a text file
 * is sent as a reference to a copy in the chat's folder, and a failed send keeps that reference instead (#2658).
 */
async function addPicture(page: Page, composer: Locator, name: string): Promise<void> {
  await composer.evaluate(
    (input, picture) => {
      const bytes = Uint8Array.from(atob(picture.base64), (char) => char.charCodeAt(0));
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([bytes], picture.name, { type: "image/png" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name, base64: PNG_BASE64 },
  );
  await expect(page.locator(ATTACHMENTS)).toContainText(name);
}

async function expectNoAttachments(page: Page): Promise<void> {
  await expect(page.locator(ATTACHMENTS)).toHaveCount(0);
}

/** A websocket message as a JSON object. A message that is not JSON reads as empty, and is forwarded unchanged. */
function parseFrame(message: string | Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(message));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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

realTest(
  "clears an attachment after admission and does not reuse it on the next message",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);

    await addFile(page, composer, "sent-once.txt");
    await composer.fill("First message with an attachment");
    // The chip is still uploading for a moment: the composer holds the send until it is attached, and Send enables then.
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expectNoAttachments(page);

    await composer.fill("Second message without an attachment");
    await composer.press("Enter");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 45_000 });
    await expectNoAttachments(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "keeps an attachment when the send fails before admission",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    let failNextPrompt = false;
    const page = await realApp.open({
      beforeLoad: async (openedPage) => {
        await openedPage.routeWebSocket(
          () => true,
          (webSocket) => {
            const server = webSocket.connectToServer();
            webSocket.onMessage((message) => {
              const frame = parseFrame(message);
              // Only a prompt is refused: the app also sends other commands over the same port (state reads, for one).
              const command = (frame.args as { command?: { type?: unknown } } | undefined)?.command;
              if (
                failNextPrompt &&
                frame.type === "call" &&
                frame.port === "A0.rpcSession" &&
                frame.method === "send" &&
                command?.type === "prompt"
              ) {
                failNextPrompt = false;
                // The server refuses the prompt before omp takes it: the send fails, and the connection stays open.
                void webSocket.send(
                  JSON.stringify({
                    type: "result",
                    id: frame.id,
                    ok: false,
                    error: {
                      code: "unavailable",
                      message: "The prompt was refused before omp took it.",
                      retryable: true,
                    },
                  }),
                );
                return;
              }
              server.send(message);
            });
          },
        );
      },
    });
    const composer = await startChat(page);

    await addPicture(page, composer, "kept-after-failure.png");
    // The chip gets its remove button when its upload has finished. Enter comes after that, as it does when a person
    // types after dropping a file.
    await expect(page.getByRole("button", { name: "Remove kept-after-failure.png" })).toBeVisible();
    failNextPrompt = true;
    await composer.fill("This send should fail before admission");
    await composer.press("Enter");
    await expect(page.locator('[data-composer-error="true"]')).toBeVisible({ timeout: 30_000 });
    // The send failed before omp took it: the chip is still in the composer, with the text.
    await expect(page.locator(ATTACHMENTS)).toContainText("kept-after-failure.png");
    await expect(composer).toHaveValue("This send should fail before admission");

    const composerArea = page.getByRole("region", { name: "Composer" });
    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await composerArea.screenshot({ path: join(screenshots, "fix-1024-failed-send-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await composerArea.screenshot({ path: join(screenshots, "fix-1024-failed-send-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await composerArea.screenshot({ path: join(screenshots, "fix-1024-failed-send-narrow.png") });

    // The saved draft keeps the attachment, and a reload restores it with the text.
    await expect
      .poll(() => storedAttachmentNames(realApp.appDataDir, "folders"), SAVED)
      .toEqual(["kept-after-failure.png"]);
    await page.reload();
    await expect(page.locator(ATTACHMENTS)).toContainText("kept-after-failure.png", {
      timeout: 60_000,
    });
    await expect(composer).toHaveValue("This send should fail before admission");
    expect(realApp.problems).toEqual([]);
  },
);
