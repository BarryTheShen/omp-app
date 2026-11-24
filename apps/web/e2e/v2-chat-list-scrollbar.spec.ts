import { expect, realTest } from "./real-omp";

/**
 * The chat list's scroll bar in WebKit, the desktop window's engine: WebKitGTK draws its own bar over a list's content,
 * and it covered each row's ⋯ (More). The list draws a thin bar of its own that takes its own room, so every row's ⋯ is
 * left of it.
 */
realTest.use({ browserName: "webkit", channel: "", seedSessions: 40 });

realTest.describe("new UI chat list in WebKit", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a long list's scroll bar takes its own room, and no row's More is under it",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        serviceWorkers: "block",
      });
      const page = await realApp.open({ path: "/", context });
      const list = page.locator('[data-tour="chat-list"]');
      await expect(list.getByRole("button", { name: "Seeded chat 1", exact: true })).toBeVisible({
        timeout: 120_000,
      });
      const room = await list.evaluate((element: HTMLElement) => ({
        bar: element.offsetWidth - element.clientWidth,
        scrolls: element.scrollHeight > element.clientHeight,
        contentRight:
          element.getBoundingClientRect().left + element.clientLeft + element.clientWidth,
      }));
      expect(room.scrolls).toBe(true);
      expect(room.bar).toBeGreaterThanOrEqual(6);
      const rights = await list
        .getByRole("button", { name: "More" })
        .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().right));
      expect(rights.length).toBeGreaterThan(10);
      for (const right of rights) expect(right).toBeLessThanOrEqual(room.contentRight);
      await context.close();
    },
  );
});
