import type { WebSocketRoute } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * A page that missed a turn's events (a Zen side panel kept "thinking…" after the reply had come in every other window,
 * its link open and no error anywhere) finds out once the chat has been quiet a while: it asks omp whether the turn
 * still runs, and as it ended, reads the chat again and shows the reply.
 */
realTest.describe("new UI: a turn the page missed", () => {
  realTest.setTimeout(180_000);

  realTest(
    "a chat shown working whose turn ended unheard shows the reply after a quiet spell",
    async ({ realApp }) => {
      let deaf = false;
      const page = await realApp.open({
        path: "/",
        beforeLoad: (opened) =>
          opened.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
            const server = socket.connectToServer();
            // While deaf, the chat's live events never reach the page; the answers to its calls do.
            server.onMessage((message) => {
              if (deaf && typeof message === "string" && message.includes('"kind":"event"')) return;
              socket.send(message);
            });
          }),
      });
      await startNewChat(page);
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box.fill("count_reply first");
      await box.press("Enter");
      await expect(page.getByText("count-1 first")).toBeVisible({ timeout: 60_000 });

      deaf = true;
      await box.fill("count_reply missed");
      await box.press("Enter");
      const transcript = page.getByRole("region", { name: "Transcript" });
      // Nothing of the turn comes: the page shows the chat working.
      await expect(transcript.getByText("thinking…")).toBeVisible({ timeout: 10_000 });
      // After the quiet spell the page asks, and reads the chat again.
      await expect(transcript.getByText("count-2 missed")).toBeVisible({ timeout: 60_000 });
      await expect(transcript.getByText("thinking…")).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );
});
