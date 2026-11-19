import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * A chat's draft with the chat open in two browsers (#24): each window follows the app's copy of the draft while its own
 * box is untouched, so a message sent in one never comes back in the other, and typed or cleared text shows in both.
 */
realTest.describe("new UI: a chat's draft in several windows", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 1 });
  const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });

  async function openChat(page: Page): Promise<void> {
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "Seeded chat 1" })
      .first()
      .click();
    await expect(box(page)).toBeVisible({ timeout: 120_000 });
  }

  realTest(
    "a window opened while another sends follows the send's clear, and does not keep the sent message",
    async ({ realApp }) => {
      // The sending window's text reaches the app's copy before the send, and its clear a moment after: the clear is
      // held here, so the other window opens in between, as it did when it kept the sent message.
      let savedSent = false;
      const a = await realApp.open({
        path: "/",
        beforeLoad: (page) =>
          page.routeWebSocket(/.*/, (ws) => {
            const server = ws.connectToServer();
            ws.onMessage((frame) => {
              const text = String(frame);
              if (!text.includes('"port":"A1.draftStore"')) return server.send(frame);
              if (text.includes('"method":"save"') && text.includes('"text":"alpha"'))
                savedSent = true;
              if (text.includes('"method":"clear"')) setTimeout(() => server.send(frame), 6_000);
              else server.send(frame);
            });
            server.onMessage((frame) => ws.send(frame));
          }),
      });
      await openChat(a);
      await box(a).fill("alpha");
      await expect.poll(() => savedSent, { timeout: 15_000 }).toBe(true);
      await box(a).press("Enter");
      await expect(transcript(a).getByText("alpha", { exact: true })).toBeVisible({
        timeout: 120_000,
      });
      const b = await realApp.open({ path: "/" });
      await openChat(b);
      await expect(box(b)).toHaveValue("alpha");
      await expect(box(b)).toHaveValue("", { timeout: 20_000 });
      await expect(box(a)).toHaveValue("");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "text typed or cleared in one window shows in the other while its box is untouched",
    async ({ realApp }) => {
      const a = await realApp.open({ path: "/" });
      await openChat(a);
      const b = await realApp.open({ path: "/" });
      await openChat(b);

      await box(a).fill("a plan for tomorrow");
      await expect(box(b)).toHaveValue("a plan for tomorrow", { timeout: 15_000 });
      await box(a).fill("");
      await expect(box(b)).toHaveValue("", { timeout: 15_000 });

      // Typed in the other window, it goes the other way too.
      await box(b).fill("from the second window");
      await expect(box(a)).toHaveValue("from the second window", { timeout: 15_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
