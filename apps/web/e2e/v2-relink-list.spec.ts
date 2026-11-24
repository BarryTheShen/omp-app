import type { WebSocketRoute } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A device away for a while (a computer asleep, a phone in the background) sees on its way back what changed meanwhile:
 * a chat another device started is in its chat list once its link is back, also when the events it missed are not
 * sent again (a page that had heard none yet).
 */
realTest.describe("new UI: back from an outage", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 1 });

  realTest(
    "a chat another device started while this one was away is in its list once it is back",
    async ({ realApp, browser }) => {
      realApp.allowProblem(/WebSocket/i);
      let away = false;
      let link: WebSocketRoute | null = null;
      const context = await browser.newContext();
      const other = await realApp.open({
        path: "/",
        context,
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            // Away: every try is turned away as soon as it is made.
            if (away) {
              void socket.close({ code: 1001, reason: "going away" });
              return;
            }
            link = socket;
            socket.connectToServer();
          }),
      });
      const list = other.getByRole("navigation", { name: "Chats" });
      await expect(list.getByRole("button", { name: "Seeded chat 1" })).toBeVisible({
        timeout: 120_000,
      });

      away = true;
      await (link as WebSocketRoute | null)?.close({ code: 1001, reason: "going away" });
      await expect(other.getByRole("button", { name: /^Connection: Reconnecting/ })).toBeVisible({
        timeout: 30_000,
      });

      // Meanwhile this device starts a chat, and its reply ends.
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("count_reply while away");
      await box.press("Enter");
      await expect(page.getByText(/count-\d+ while/)).toBeVisible({ timeout: 60_000 });

      // Back: the new chat is in the other device's list.
      away = false;
      await expect(list.getByRole("button", { name: /count_reply while away/ })).toBeVisible({
        timeout: 60_000,
      });
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );
});
