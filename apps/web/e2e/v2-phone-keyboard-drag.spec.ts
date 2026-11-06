import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * With the keyboard up on an iPhone, a drag past the end of the chat panned the whole page, and the app pulled it back
 * at every step of the pan and its momentum: it shook for about two seconds. Now a drag no box can take along its
 * direction is stopped while the keyboard is up, and no box hands a drag on to the page at its end. The keyboard is
 * played by a stand-in visual viewport, set before the app loads.
 */
realTest.describe("new UI on a phone, drags with the keyboard up", () => {
  realTest.setTimeout(240_000);

  /** Puts the stand-in keyboard up (the visible height) or down (`null`). */
  const keyboard = (page: Page, height: number | null) =>
    page.evaluate(
      (height) => (window as unknown as { keyboard: (h: number | null) => void }).keyboard(height),
      height,
    );

  /** A one-finger drag by (dx, dy) starting on the first element `selector` names: whether the page stopped it. */
  const drag = (page: Page, selector: string, dx: number, dy: number) =>
    page.evaluate(
      ({ selector, dx, dy }) => {
        const target = document.querySelector(selector);
        if (target === null) throw new Error(`no ${selector}`);
        const rect = target.getBoundingClientRect();
        const x = rect.left + Math.min(20, rect.width / 2);
        const y = rect.top + Math.min(20, rect.height / 2);
        const touch = (cx: number, cy: number) =>
          new Touch({ identifier: 1, target, clientX: cx, clientY: cy });
        const fire = (type: string, touches: Touch[], changed: Touch[]) => {
          const event = new TouchEvent(type, {
            touches,
            targetTouches: touches,
            changedTouches: changed,
            bubbles: true,
            cancelable: true,
          });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        fire("touchstart", [touch(x, y)], [touch(x, y)]);
        const stopped = fire("touchmove", [touch(x + dx, y + dy)], [touch(x + dx, y + dy)]);
        fire("touchend", [], [touch(x + dx, y + dy)]);
        return stopped;
      },
      { selector, dx, dy },
    );

  realTest(
    "with the keyboard up a drag no box can take is stopped; the chat, the key row sideways and the box's own drags go on",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      await context.addInitScript(() => {
        const listeners = new Map<string, Set<EventListener>>();
        const real = window.visualViewport;
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
            stand.height = height ?? real?.height ?? window.innerHeight;
            for (const listener of listeners.get("resize") ?? []) listener(new Event("resize"));
          },
        });
      });
      const page = await realApp.open({ path: "/", context });
      const box = page.getByRole("textbox", { name: "Message" });
      await expect(box).toHaveAttribute("placeholder", /^Message /, { timeout: 120_000 });
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await box.fill("long_reply_probe");
      await page.getByRole("button", { name: "Send" }).tap();
      await expect(page.getByText("Paragraph 40 of a long reply.")).toBeVisible({
        timeout: 60_000,
      });

      await box.tap();
      await keyboard(page, 478);
      await expect
        .poll(() => page.locator("#root").evaluate((root) => innerHeight > root.clientHeight + 100))
        .toBe(true);
      const topBar = '[data-tour="phone-top-bar"]';
      const chat = 'section[aria-label="Transcript"] .tl-item p';
      const keyRow = '[role="toolbar"][aria-label="Keys"] button';
      // The chat scrolls, and at its end it hands nothing on to the page.
      expect(await drag(page, chat, 0, -60)).toBe(false);
      expect(await drag(page, chat, 0, 60)).toBe(false);
      expect(
        await page
          .locator('section[aria-label="Transcript"]')
          .evaluate((section) => getComputedStyle(section).overscrollBehaviorY),
      ).toBe("contain");
      // The key row is one line that does not scroll (#2837): a drag on it either way would pan the page.
      expect(await drag(page, keyRow, -80, 3)).toBe(true);
      expect(await drag(page, keyRow, 2, -50)).toBe(true);
      // Nothing scrolls in the top bar: a drag there would pan the page.
      expect(await drag(page, topBar, 0, -50)).toBe(true);
      // iOS moves the caret and the selection with a finger on the focused box.
      await expect(box).toBeFocused();
      expect(await drag(page, 'textarea[aria-label="Message"]', 30, 0)).toBe(false);

      // The keyboard down: nothing is stopped.
      await keyboard(page, null);
      expect(await drag(page, topBar, 0, -50)).toBe(false);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
