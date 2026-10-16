import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect, realTest, sendPrompt } from "./real-omp";

realTest.setTimeout(300_000);

/** Whether a client frame asks omp for a chat's entries: the request a chat's open makes to load its history. */
function asksForEntries(message: string | Buffer): boolean {
  const text = typeof message === "string" ? message : message.toString("utf8");
  return text.includes('"command":{"type":"get_entries"');
}

/**
 * Clicks "New chat" and waits for the composer. Starting a real omp can take well over the shared helper's 30 s on a
 * loaded machine, so this waits longer: the start is slow, the behaviour under test is not.
 */
async function startChatSlowly(page: Page): Promise<Locator> {
  await page
    .locator('[aria-label="Sessions"]')
    .getByRole("button", { name: "New chat" })
    .first()
    .click();
  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  return composer;
}

/**
 * Issue #1617. The connection drops while a picked chat's history is still loading: the open fails and the chat closes.
 * Once the connection is back the chat opens again on its own, with its history, and it takes the next reply.
 */
realTest(
  "a chat whose history load loses the connection is opened again once the connection is back",
  async ({ realApp }) => {
    const sockets: WebSocketRoute[] = [];
    // Set when the drop is due: the next history request of a chat's open closes the connection before omp answers.
    let dropDuringLoad = false;
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.routeWebSocket(/\/ws\?/, (socket) => {
          sockets.push(socket);
          const server = socket.connectToServer();
          server.onMessage((message) => socket.send(message));
          socket.onMessage((message) => {
            if (dropDuringLoad && asksForEntries(message)) {
              dropDuringLoad = false;
              void socket.close().catch(() => undefined);
              return;
            }
            server.send(message);
          });
        });
      },
    });

    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    const composer = await startChatSlowly(page);
    await sendPrompt(composer, "ping");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });

    // A New chat takes the screen and has opened before the pick, so the pick is not held behind its open.
    await startChatSlowly(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 90_000 });
    dropDuringLoad = true;
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /ping/ })
      .click();
    await expect.poll(() => sockets.length, { timeout: 30_000 }).toBe(2);

    // Nobody picks the chat again: once the connection is back the chat is open with its history, and it answers.
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });
    const reopened = page.getByRole("textbox", { name: "Message input" });
    await sendPrompt(reopened, "ping");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
