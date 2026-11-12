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
      // The full app, opened on a link that names the chat (`#chat=<id>`). The lite view replaces a chat its address
      // names at load by itself (v2-lite.spec.ts); only this app asks first.
      const page = await realApp.open({ path: "/" });
      const origin = new URL(page.url()).origin;
      await page.goto(`${origin}/?linked=1#chat=01a1ffff-0000-7000-8000-000000000000`);
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

  realTest(
    "a saved chat rewound to its start that the server then reports gone is not replaced: no new chat starts, and nothing is sent to one",
    async ({ realApp }) => {
      // After Edit, the next send finds the chat gone from the server, and the chat cannot be opened again either: the
      // case where an empty chat is renewed as a new one. The chat is not empty (its messages are in the file, past the
      // point the edit went back to), so it is never replaced.
      realApp.allowProblem(/server not have this chat/i);
      let failing = false;
      let reopenAsked = 0;
      const sentWhileFailing: string[] = [];
      const failure = (socket: WebSocketRoute, id: unknown, code: string): void =>
        socket.send(
          JSON.stringify({
            type: "result",
            id,
            ok: false,
            error: {
              code,
              message: "The test made the server not have this chat",
              retryable: false,
            },
          }),
        );
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const text = typeof message === "string" ? message : "";
              if (failing && text.includes('"port":"A0.chatSession"')) {
                sentWhileFailing.push(text);
                const id = (JSON.parse(text) as { id: unknown }).id;
                if (text.includes('"method":"request"') && text.includes('"method":"prompt"')) {
                  failure(socket, id, "not_found");
                  return;
                }
                if (isOpenCall(message)) {
                  reopenAsked += 1;
                  failure(socket, id, "internal");
                  return;
                }
              }
              server.send(message);
            });
            server.onMessage((message) => socket.send(message));
          }),
      });
      await startNewChat(page);
      const composer = box(page);
      const transcript = page.getByRole("region", { name: "Transcript" });
      const edit = page.getByRole("button", { name: "Edit this message" });
      await expect(composer).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await composer.fill("first question");
      await composer.press("Enter");
      await expect(transcript.getByText("pong")).toHaveCount(1, { timeout: 60_000 });
      await expect(edit).toHaveCount(1, { timeout: 30_000 });

      await transcript.getByText("first question").hover();
      await edit.click();
      await expect(composer).toHaveValue("first question");
      await expect(transcript.getByText("first question")).toHaveCount(0);

      failing = true;
      await composer.press("Enter");
      await expect.poll(() => reopenAsked, { timeout: 30_000 }).toBeGreaterThan(0);
      // Time for a replacement to be asked for, were it going to be.
      await page.waitForTimeout(1_500);
      expect(sentWhileFailing.filter((frame) => frame.includes('"start":"new"'))).toEqual([]);
      // The chat shown is still the one rewound: it was not given up for a new one.
      await expect(page.getByText(/^Could not open this chat/)).toHaveCount(0);
    },
  );
});
