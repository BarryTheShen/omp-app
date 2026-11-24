import { expect, realTest } from "./real-omp";

/**
 * Enter on a tablet: with its on-screen keyboard up, the return key adds a line (that keyboard has no Shift+Enter) and
 * the Send button sends; with a hardware keyboard (no on-screen one), Enter sends and Shift+Enter adds a line, as on a
 * computer. The on-screen keyboard is a stand-in visual viewport that gets shorter, as iOS's keyboard makes it.
 */
realTest.describe("new UI: Enter on a tablet", () => {
  realTest.use({ seedSessions: 1 });

  realTest(
    "the on-screen keyboard's return adds a line; a hardware keyboard's Enter sends",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      });
      await context.addInitScript(() => {
        const listeners = new Map<string, Set<EventListener>>();
        const stand = {
          height: window.innerHeight,
          width: window.innerWidth,
          scale: 1,
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          addEventListener: (type: string, listener: EventListener) => {
            const set = listeners.get(type) ?? new Set();
            set.add(listener);
            listeners.set(type, set);
          },
          removeEventListener: (type: string, listener: EventListener) =>
            listeners.get(type)?.delete(listener),
        };
        Object.defineProperty(window, "visualViewport", { value: stand, configurable: true });
        Object.assign(window, {
          keyboard: (height: number | null) => {
            stand.height = height === null ? window.innerHeight : window.innerHeight - height;
            for (const listener of listeners.get("resize") ?? []) listener(new Event("resize"));
          },
        });
      });
      const page = await realApp.open({ path: "/", context });
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Seeded chat 1" })
        .tap({ timeout: 120_000 });
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", /^(Fake Model|Message omp)/, {
        timeout: 120_000,
      });

      // The on-screen keyboard is up: return adds a line, nothing is sent.
      await box.tap();
      await page.evaluate(() =>
        (window as unknown as { keyboard: (h: number) => void }).keyboard(380),
      );
      await box.fill("first line");
      await box.press("Enter");
      await box.pressSequentially("second line");
      await expect(box).toHaveValue("first line\nsecond line");

      // A hardware keyboard: no on-screen one. Shift+Enter adds a line, Enter sends.
      await page.evaluate(() =>
        (window as unknown as { keyboard: (h: null) => void }).keyboard(null),
      );
      await box.press("Shift+Enter");
      await box.pressSequentially("count_reply typed");
      await box.press("Enter");
      await expect(page.getByText(/count-\d+ typed/)).toBeVisible({ timeout: 60_000 });
      await expect(box).toHaveValue("");
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );
});
