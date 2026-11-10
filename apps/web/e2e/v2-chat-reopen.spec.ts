import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A chat that could not open is not stuck until the page reloads: an open the link to the server dropped under is made
 * again by itself once the link is back; any other failure has Try again; a chat the server no longer has has New chat.
 */
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

/** The chat's open call, as the page sends it. */
function isOpenCall(message: string | Buffer): boolean {
  if (typeof message !== "string") return false;
  return message.includes('"port":"A0.chatSession"') && message.includes('"method":"open"');
}

/** Sends `hello` and waits for the fake model's `pong`: the chat works. */
async function chatWorks(page: Page): Promise<void> {
  await box(page).fill("hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
}

/** Counts loads of the page from now on: a chat opened again in place loads nothing. */
function countLoads(page: Page): () => number {
  let loads = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) loads += 1;
  });
  return () => loads;
}

realTest.describe("new UI: a chat that could not open", () => {
  realTest.setTimeout(240_000);

  realTest(
    "the link drops while the chat opens: it opens by itself once the link is back, without a reload",
    async ({ realApp }) => {
      realApp.allowProblem(/WebSocket/i);
      let cut = false;
      let opens = 0;
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              if (isOpenCall(message)) {
                opens += 1;
                // The first open's link goes away under it, before the server has it.
                if (!cut) {
                  cut = true;
                  void socket.close({ code: 1001, reason: "going away" });
                  return;
                }
              }
              server.send(message);
            });
          }),
      });
      const loads = countLoads(page);
      await startNewChat(page);
      await chatWorks(page);
      expect(cut).toBe(true);
      expect(opens).toBeGreaterThanOrEqual(2);
      await expect(page.getByText(/^Could not open this chat/)).toHaveCount(0);
      expect(loads()).toBe(0);
    },
  );

  realTest(
    "an open the server failed says why, and Try again opens the chat",
    async ({ realApp }) => {
      let failed = false;
      let openId: unknown = null;
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              if (openId === null && isOpenCall(message))
                openId = (JSON.parse(message as string) as { id: unknown }).id;
              server.send(message);
            });
            // The first open's answer becomes a failure, as the server's own would come.
            server.onMessage((message) => {
              if (!failed && openId !== null && typeof message === "string") {
                const frame = JSON.parse(message) as { type?: string; id?: unknown };
                if (frame.type === "result" && frame.id === openId) {
                  failed = true;
                  socket.send(
                    JSON.stringify({
                      type: "result",
                      id: openId,
                      ok: false,
                      error: {
                        code: "internal",
                        message: "The test failed this open",
                        retryable: false,
                      },
                    }),
                  );
                  return;
                }
              }
              socket.send(message);
            });
          }),
      });
      const loads = countLoads(page);
      await startNewChat(page);
      const failure = page.getByRole("alert").filter({
        hasText: "Could not open this chat: The test failed this open",
      });
      await expect(failure).toBeVisible({ timeout: 90_000 });
      await failure.getByRole("button", { name: "Try again" }).click();
      await expect(failure).toHaveCount(0);
      await chatWorks(page);
      expect(loads()).toBe(0);
    },
  );

  realTest(
    "a chat the server no longer has says so, and New chat starts one in its place",
    async ({ realApp }) => {
      const page = await realApp.open({
        path: "/lite",
        search: "?chat=01a1ffff-0000-7000-8000-000000000000",
      });
      const missing = page.getByRole("alert").filter({
        hasText: "Could not open this chat: the app's server no longer has it.",
      });
      await expect(missing).toBeVisible({ timeout: 90_000 });
      await expect(missing.getByRole("button", { name: "Try again" })).toHaveCount(0);
      await missing.getByRole("button", { name: "New chat" }).click();
      await expect(missing).toHaveCount(0);
      await chatWorks(page);
    },
  );
});
