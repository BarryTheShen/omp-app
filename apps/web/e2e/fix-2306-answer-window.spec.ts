import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, type RealApp, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

const LONG_DRAFT = Array.from({ length: 400 }, (_, index) => `word${index + 1}`).join(" ");

function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

function parseFrame(message: string | Buffer): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(message));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Holds the first read of a thread's draft that the page asks for after the chat's first prompt is sent. A chat's draft
 * moves from the New chat's draft to its own thread's draft by that read, so holding it keeps the move open: the text
 * typed while it is held is in the New chat's draft, which is the window this test closes the page in.
 */
function holdFirstThreadDraftRead() {
  let held = false;
  return {
    wasHeld: (): boolean => held,
    install: (openedPage: Page): Promise<void> =>
      openedPage.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          let promptSent = false;
          webSocket.onMessage((message) => {
            const frame = parseFrame(message);
            if (
              frame.type === "call" &&
              frame.port === "A0.chatSession" &&
              frame.method === "request"
            ) {
              promptSent = true;
            }
            const args = frame.args as { scope?: { kind?: unknown } } | undefined;
            if (
              promptSent &&
              !held &&
              frame.type === "call" &&
              frame.port === "A1.draftStore" &&
              frame.method === "get" &&
              args?.scope?.kind === "thread"
            ) {
              held = true;
              return;
            }
            server.send(message);
          });
          server.onMessage((message) => {
            webSocket.send(message);
          });
        },
      ),
  };
}

/** The draft texts this browser and the app's data folder hold, for a failure's message. */
async function draftTexts(realApp: RealApp, page: Page): Promise<string> {
  const buffers = await page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.includes(":draft:"))
      .map(([key, raw]) => `${key}: ${raw.slice(0, 160)}`),
  );
  const files: string[] = [];
  for (const directory of ["threads", "folders"]) {
    const path = join(realApp.appDataDir, "drafts", directory);
    const names = await readdir(path).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const saved = JSON.parse(await readFile(join(path, name), "utf8")) as {
        scope?: unknown;
        text?: unknown;
      };
      files.push(
        `${directory}/${name} scope=${JSON.stringify(saved.scope)} text=${String(saved.text).slice(0, 40)}`,
      );
    }
  }
  const saved = await page.evaluate(() => localStorage.getItem("omp.app.root.thread"));
  return `buffers: ${JSON.stringify(buffers)}\nfiles: ${JSON.stringify(files)}\nsaved thread: ${saved}`;
}

async function expectComposerValue(realApp: RealApp, page: Page, expected: string): Promise<void> {
  try {
    await expect.poll(() => composer(page).inputValue(), { timeout: 120_000 }).toBe(expected);
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(`${original}\n${await draftTexts(realApp, page)}`);
  }
}

realTest(
  "text typed right after a chat's first answer stays in that chat when the page closes at once",
  async ({ realApp }) => {
    const hold = holdFirstThreadDraftRead();
    const page = await realApp.open({ beforeLoad: hold.install });
    const input = await startChat(page);
    await sendPrompt(input, "seed answer window");
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    // The chat's move to its own draft is waiting for its read, so the text typed now is in the window.
    await expect.poll(() => hold.wasHeld(), { timeout: 120_000 }).toBe(true);
    await input.fill(LONG_DRAFT);
    await expect(input).toHaveValue(LONG_DRAFT, { timeout: 120_000 });
    const profile = page.context();
    await page.close({ runBeforeUnload: false });

    const reopened = await realApp.open({ context: profile, expectApp: false });
    const row = reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option")
      .filter({ hasText: /seed answer window/ })
      .first();
    await expect(row).toHaveCount(1, { timeout: 120_000 });
    await row.click();
    await expect(composer(reopened)).toBeVisible({ timeout: 120_000 });
    await expectComposerValue(realApp, reopened, LONG_DRAFT);
    expect(realApp.problems).toEqual([]);
  },
);
