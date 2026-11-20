import type { WebSocketRoute } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A chat opened as its reply ends: the page reads the chat's window, then subscribes to its events. When the reply ends
 * between the two and the server no longer holds the chat's early events (it keeps its last 256; a streamed reply has
 * more), the reply reached the page neither in the window nor in a replay, and stayed missing. The panel here holds its
 * subscription back until the reply ended in the other window, which makes that gap as wide as the whole turn.
 */
realTest.describe("a chat opened as its reply ends", () => {
  realTest.setTimeout(300_000);

  realTest(
    "a reply that ended between the window's read and the subscription shows once the chat is live",
    async ({ realApp, browser }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("stream_steady");
      await box.press("Enter");
      await expect(page.getByText(/Steady line 3:/)).toBeVisible({ timeout: 60_000 });

      let holding = false;
      const held: Array<() => void> = [];
      const context = await browser.newContext({ viewport: { width: 420, height: 800 } });
      const lite = await realApp.open({
        path: "/lite",
        context,
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            const server = socket.connectToServer();
            socket.onMessage((message) => {
              const text = typeof message === "string" ? message : "";
              if (
                holding &&
                text.includes('"type":"subscribe"') &&
                text.includes("A0.chatSession")
              ) {
                held.push(() => server.send(message));
                return;
              }
              server.send(message);
            });
            server.onMessage((message) => socket.send(message));
          }),
      });
      await expect(lite.getByRole("heading", { name: "New chat" })).toBeVisible({
        timeout: 120_000,
      });
      // The panel opens the chat mid-reply: its window is read now, its subscription waits.
      holding = true;
      await lite.getByTitle("Recent chats").click();
      await lite.getByRole("option", { name: "stream_steady" }).click();
      await expect.poll(() => held.length, { timeout: 30_000 }).toBeGreaterThan(0);

      // The reply ends in the other window; then the panel's subscription goes out.
      await expect(page.getByText(/Steady line 239:/)).toBeVisible({ timeout: 150_000 });
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
      holding = false;
      for (const send of held.splice(0)) send();
      await expect(lite.getByText(/Steady line 239:/)).toBeVisible({ timeout: 30_000 });
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );
});
