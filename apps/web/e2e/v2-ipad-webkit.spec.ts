import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI on an iPad in WebKit, Safari's engine: a touch screen at the iPad's 1180×820, held sideways, with a
 * trackpad. Settings scrolls under the trackpad wherever the pointer is, also over a card or a clipped row.
 */
realTest.use({ browserName: "webkit", channel: "" });

realTest.describe("new UI on an iPad in WebKit", () => {
  realTest.setTimeout(240_000);

  /** How far Settings' page is scrolled. */
  const scrolled = (page: Page) =>
    page.evaluate(() => {
      const scroller = [...document.querySelectorAll<HTMLElement>('[role="dialog"] *')].find(
        (each) =>
          /(auto|scroll)/.test(getComputedStyle(each).overflowY) &&
          each.scrollHeight > each.clientHeight + 1 &&
          each.clientHeight > 300,
      );
      return scroller?.scrollTop ?? -1;
    });

  realTest(
    "Settings scrolls under a trackpad wherever the pointer is, a theme card too",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      const settings = page.getByRole("button", { name: "Settings" }).first();
      await expect(settings).toBeVisible({ timeout: 120_000 });
      await settings.click();
      const text = page.getByRole("dialog").first().getByText("How this app looks");
      await expect(text).toBeVisible();
      const at = await text.boundingBox();
      if (at === null) throw new Error("the App page is not drawn");
      // The first wheel moves the theme cards under the pointer; the next ones scroll over a card.
      await page.mouse.move(at.x + 20, at.y + at.height / 2);
      await page.mouse.wheel(0, 300);
      await expect.poll(() => scrolled(page)).toBe(300);
      await page.mouse.wheel(0, 300);
      await expect.poll(() => scrolled(page)).toBe(600);
      await page.mouse.wheel(0, -600);
      await expect.poll(() => scrolled(page)).toBe(0);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
