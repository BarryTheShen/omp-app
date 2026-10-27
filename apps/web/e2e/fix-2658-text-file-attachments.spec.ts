import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * #2658: a text file attached in the composer never reached the model, because omp's prompt carries pictures only. At
 * send, the composer now saves each text file into the chat's `local` folder and cites it by its reference after the
 * typed text, as large pastes saved as a file are (#1291).
 */

const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';
const NOTES = "The secret word is marigold.\nsecond line of the notes";
const REFERENCE = "local://notes.txt";
const SAVED = { timeout: 45_000 } as const;

/** A websocket message as a JSON object. A message that is not JSON reads as empty, and is forwarded unchanged. */
function parseFrame(message: string | Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      typeof message === "string" ? message : message.toString("utf8"),
    );
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Drops one text file onto the composer, as a person does from the file manager. */
async function dropTextFile(
  page: Page,
  composer: Locator,
  name: string,
  text: string,
): Promise<void> {
  await composer.evaluate(
    (input, file) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([file.text], file.name, { type: "text/plain" }));
      input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { name, text },
  );
  await expect(page.locator(ATTACHMENTS)).toContainText(name);
  // The chip gets its remove button once its upload has finished.
  await expect(page.getByRole("button", { name: `Remove ${name}` })).toBeVisible();
}

/** The omp session files of this run whose text contains `text`: the chats that cite it. */
async function sessionFilesContaining(agentDir: string, text: string): Promise<string[]> {
  const sessions = join(agentDir, "sessions");
  let names: string[];
  try {
    names = await readdir(sessions, { recursive: true });
  } catch {
    return []; // omp has not written a session yet; the poll asks again
  }
  const found: string[] = [];
  for (const name of names.filter((file) => file.endsWith(".jsonl"))) {
    const path = join(sessions, name);
    if ((await readFile(path, "utf8")).includes(text)) found.push(path);
  }
  return found;
}

realTest(
  "a text file attached in the composer is saved in the chat's folder, cited by the message, and read by the agent",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open({
      beforeLoad: (openedPage) => openedPage.emulateMedia({ colorScheme: "light" }),
    });
    const composer = await startChat(page);

    await dropTextFile(page, composer, "notes.txt", NOTES);
    // The fake model reads the first `local://` reference of a message that asks it to, with omp's own read tool.
    await composer.fill("read_attached_file");
    await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText("reference read", { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    });

    // The message shows the reference after the typed text, and the composer is empty, its chip gone.
    await expect(page.getByText(REFERENCE).first()).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(page.locator(ATTACHMENTS)).toHaveCount(0);

    // omp stored the message with the reference, and its read of the copy holds the file's whole text: the agent saw it.
    await expect
      .poll(() => sessionFilesContaining(realApp.agentDir, "second line of the notes"), SAVED)
      .not.toEqual([]);
    const [sessionFile] = await sessionFilesContaining(realApp.agentDir, REFERENCE);
    const folder = (sessionFile ?? "").slice(0, -".jsonl".length);
    expect(await readFile(join(folder, "local", "notes.txt"), "utf8")).toBe(NOTES);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2658-sent-light.png") });
    // The app follows the browser's colour scheme live, so the same chat turns dark without a second page or chat.
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2658-sent-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-2658-sent-390.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a send refused after its file was saved keeps the reference without the chip, and the retry saves nothing again",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    let refuseNextPrompt = false;
    const page = await realApp.open({
      beforeLoad: async (openedPage) => {
        await openedPage.routeWebSocket(
          () => true,
          (webSocket) => {
            const server = webSocket.connectToServer();
            webSocket.onMessage((message) => {
              const frame = parseFrame(message);
              // Only the prompt is refused: the file's save and the app's other calls go through.
              const method = (frame.args as { method?: unknown } | undefined)?.method;
              if (
                refuseNextPrompt &&
                frame.type === "call" &&
                frame.port === "A0.chatSession" &&
                frame.method === "request" &&
                method === "prompt"
              ) {
                refuseNextPrompt = false;
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

    await dropTextFile(page, composer, "notes.txt", NOTES);
    refuseNextPrompt = true;
    await composer.fill("read_attached_file");
    await composer.press("Enter");
    await expect(page.locator('[data-composer-error="true"]')).toBeVisible({ timeout: 30_000 });
    // The file was saved and the message cites it: the box keeps the message with its reference, and the chip is gone.
    await expect(composer).toHaveValue(`read_attached_file\n\n${REFERENCE}`);
    await expect(page.locator(ATTACHMENTS)).toHaveCount(0);

    // The retry sends the same reference, and the agent reads the copy saved the first time.
    await composer.press("Enter");
    await expect(page.getByText("reference read", { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect
      .poll(() => sessionFilesContaining(realApp.agentDir, "second line of the notes"), SAVED)
      .not.toEqual([]);
    const [sessionFile] = await sessionFilesContaining(realApp.agentDir, REFERENCE);
    const folder = (sessionFile ?? "").slice(0, -".jsonl".length);
    expect(await readdir(join(folder, "local"))).toEqual(["notes.txt"]);
    expect(realApp.problems).toEqual([]);
  },
);
