import type { WebSocketRoute } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

/** The id of a client frame that subscribes to a chat's event stream, or undefined for any other frame. */
function chatSubscribeId(message: string | Buffer): string | undefined {
  const text = typeof message === "string" ? message : message.toString("utf8");
  if (!text.includes('"type":"subscribe"') || !text.includes('"stream":"A0.rpcSession/event/')) {
    return undefined;
  }
  return /"id":"([^"]+)"/.exec(text)?.[1];
}

/** The id of a client frame that asks for a chat's entries (the history a chat opens with), or undefined. */
function entriesRequestId(message: string | Buffer): string | undefined {
  const text = typeof message === "string" ? message : message.toString("utf8");
  if (!text.includes('"command":{"type":"get_entries"')) return undefined;
  return /"id":"([^"]+)"/.exec(text)?.[1];
}

/** The id of a server frame that answers a request, or undefined for any other frame. */
function resultId(message: string | Buffer): string | undefined {
  const text = typeof message === "string" ? message : message.toString("utf8");
  return /^\{"type":"result","id":"([^"]+)"/.exec(text)?.[1];
}

/**
 * Issue #1081. The connection drops and the app reconnects; the server refuses the chat's resubscribe. The refusal is
 * made on the wire, in the page's own socket, and nothing else is changed. The chat then stays quiet until the person
 * switches away and back: that reopen subscribes afresh, and the chat receives its next reply.
 */
realTest(
  "a chat whose resubscribe the server refuses after a reconnect receives its next reply after switching away and back",
  async ({ realApp }) => {
    const sockets: WebSocketRoute[] = [];
    let refuseNext = false;
    // The reopen after the switch: the history request the page sends, and whether its answer has arrived.
    let watching = false;
    const historyRequests = new Set<string>();
    let historyLoaded = false;
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.routeWebSocket(/\/ws\?/, (socket) => {
          sockets.push(socket);
          const server = socket.connectToServer();
          server.onMessage((message) => {
            const id = resultId(message);
            if (id !== undefined && historyRequests.has(id)) historyLoaded = true;
            socket.send(message);
          });
          socket.onMessage((message) => {
            const id = chatSubscribeId(message);
            if (refuseNext && id !== undefined) {
              refuseNext = false;
              socket.send(
                JSON.stringify({
                  type: "result",
                  id,
                  ok: false,
                  error: { code: "not_found", message: "This chat is closed.", retryable: false },
                }),
              );
              return;
            }
            const history = entriesRequestId(message);
            if (watching && history !== undefined) historyRequests.add(history);
            server.send(message);
          });
        });
      },
    });

    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    const composer = await startChat(page);
    // The chat has finished opening (the thread shows its empty state, not "Loading conversation…") before the prompt
    // goes out: the drop must land on an open chat. A drop during its history load fails the open and closes the chat
    // (#1617).
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(composer, "ping");
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });

    // The connection drops. The app reconnects and resubscribes the chat, and the server refuses it.
    const first = sockets[0];
    if (first === undefined) throw new Error("the page opened no socket");
    refuseNext = true;
    await first.close();
    await expect.poll(() => sockets.length, { timeout: 30_000 }).toBe(2);
    await expect.poll(() => refuseNext, { timeout: 30_000 }).toBe(false);

    // Switch away and back. The reopen subscribes afresh; its history must have arrived before anything is typed, since
    // the chat's draft lands with it and would replace text typed earlier. The old chat's reply stays on screen until then.
    await startChat(page);
    watching = true;
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /ping/ })
      .click();
    await expect.poll(() => historyLoaded, { timeout: 60_000 }).toBe(true);
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(1, { timeout: 60_000 });

    const reopened = page.getByRole("textbox", { name: "Message input" });
    await sendPrompt(reopened, "ping");
    await expect(reopened).toHaveValue("", { timeout: 30_000 });
    await expect(transcript.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 60_000 });
    expect(realApp.problems).toEqual([]);
  },
);
