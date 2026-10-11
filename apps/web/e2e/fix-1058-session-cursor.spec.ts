import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * #1058 on real omp: the server changes while the chat list is open, so the page the list holds still has a cursor
 * from before the change. The first session page's cursor is rewritten on the wire to "50", the numeric offset the
 * server no longer accepts. 'Show older chats' is refused; the list is read again from its start with no message, and
 * the next click reaches the oldest chat.
 */
realTest.use({ seedSessions: 60 });

type Wire = { listResults: number; staleCursorGiven: boolean };

/** The first session page the app receives gets the stale cursor; later pages pass through unchanged. */
async function staleFirstSessionPage(page: Page, wire: Wire): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      let text = String(message);
      try {
        const frame = JSON.parse(text) as { type?: unknown; ok?: unknown; value?: unknown };
        const value = frame.value as { sessions?: unknown; nextCursor?: unknown } | undefined;
        if (
          frame.type === "result" &&
          frame.ok === true &&
          Array.isArray(value?.sessions) &&
          typeof value?.nextCursor === "string"
        ) {
          wire.listResults += 1;
          if (!wire.staleCursorGiven) {
            wire.staleCursorGiven = true;
            value.nextCursor = "50";
            text = JSON.stringify(frame);
          }
        }
      } catch {
        // Non-JSON frames are forwarded unchanged.
      }
      ws.send(text);
    });
  });
}

realTest(
  "a 'Show older chats' the server refuses reads the list again with no message, and the next click reaches the oldest chat",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const wire: Wire = { listResults: 0, staleCursorGiven: false };
    const page = await realApp.open({
      beforeLoad: (openedPage) => staleFirstSessionPage(openedPage, wire),
    });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option")).toHaveCount(50, { timeout: 60_000 });
    // The rewrite applied: the list holds the stale cursor, so the next request is the refused one.
    expect(wire.staleCursorGiven).toBe(true);

    const listResultsBefore = wire.listResults;
    await page.getByRole("button", { name: "Show older chats" }).click();
    // The server refuses the stale cursor, and the list is read again from its start.
    await expect
      .poll(() => wire.listResults, { timeout: 30_000 })
      .toBeGreaterThan(listResultsBefore);
    // No message says why: the app's own empty live region has role alert too, so the text is what is checked.
    await expect(page.getByText("Couldn't load older chats")).toHaveCount(0);
    await expect(list.getByRole("option")).toHaveCount(50);

    await page.getByRole("button", { name: "Show older chats" }).click();
    await expect(list.getByRole("option")).toHaveCount(60, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: /older chats/ })).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
