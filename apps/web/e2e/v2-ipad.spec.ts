import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI on a tablet (an iPad's 820×1180 with touch), on real omp: the controls a finger takes are at least 44 px,
 * a pane's divider is taken from close to its line, and a desktop page keeps its sizes.
 */
realTest.describe("new UI on a tablet", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 2 });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  /** A control's width and height, rounded. */
  const size = async (control: Locator): Promise<[number, number]> => {
    await expect(control).toBeVisible({ timeout: 60_000 });
    const bounds = await control.boundingBox();
    return bounds === null ? [0, 0] : [Math.round(bounds.width), Math.round(bounds.height)];
  };
  // Polled: a sheet or menu that opens grows from a smaller scale, and its controls reach their size when it ends.
  const tall = async (control: Locator) =>
    expect.poll(async () => (await size(control))[1]).toBeGreaterThanOrEqual(44);
  const square = async (control: Locator) =>
    expect.poll(async () => Math.min(...(await size(control)))).toBeGreaterThanOrEqual(44);

  async function tablet(
    realApp: { open: (options: { path: string; context: BrowserContext }) => Promise<Page> },
    browser: { newContext: (options: object) => Promise<BrowserContext> },
  ): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({
      viewport: { width: 820, height: 1180 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2,
    });
    const page = await realApp.open({ path: "/", context });
    await chats(page).getByRole("button", { name: "Seeded chat 1" }).tap({ timeout: 120_000 });
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    return { page, context };
  }

  realTest(
    "the list, the message box, a message, the panes and the side panels have controls a finger's size",
    async ({ realApp, browser }) => {
      const { page, context } = await tablet(realApp, browser);
      const list = chats(page);
      await tall(list.getByRole("button", { name: "Seeded chat 2" }));
      await square(list.getByRole("button", { name: "Pin" }).first());
      await square(list.getByRole("button", { name: "More" }).first());
      await tall(page.getByRole("button", { name: "New chat" }).first());
      await square(page.getByRole("button", { name: "What's new" }));
      await square(page.getByRole("button", { name: "Settings", exact: true }).first());

      await tall(page.getByRole("button", { name: /^Model: / }));
      await tall(page.getByRole("button", { name: /^Thinking: / }));
      await tall(page.getByRole("button", { name: "Plan", exact: true }));
      await square(page.getByRole("button", { name: "Send" }));
      await square(page.getByRole("button", { name: "Copy this message" }));
      await square(page.getByRole("button", { name: "Usage", exact: true }));

      await page.keyboard.press("Control+Shift+O");
      await expect(box(page)).toHaveCount(2, { timeout: 60_000 });
      await tall(page.locator(".dv-tab").first());
      await square(page.getByRole("button", { name: "Close Seeded chat 1" }));
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "a pane's divider is taken from close to its line, and Settings' rows are a finger's size",
    async ({ realApp, browser }) => {
      const { page, context } = await tablet(realApp, browser);
      await page.keyboard.press("Control+Shift+O");
      await expect(box(page)).toHaveCount(2, { timeout: 60_000 });
      const sash = page.locator(
        ".dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash.dv-enabled",
      );
      const line = await sash.first().boundingBox();
      if (line === null) throw new Error("no divider between the panes");
      const middle = { x: line.x + line.width / 2, y: line.y + line.height / 2 };
      // 14 px from the line, the touch still lands on the divider.
      const taken = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest(".dv-sash") !== null,
        { x: middle.x + 14, y: middle.y },
      );
      expect(taken).toBe(true);
      const left = page.locator(".dv-groupview").first();
      const before = (await left.boundingBox())?.width ?? 0;
      await page.mouse.move(middle.x + 14, middle.y);
      await page.mouse.down();
      await page.mouse.move(middle.x + 114, middle.y, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(async () => ((await left.boundingBox())?.width ?? 0) - before)
        .toBeGreaterThan(80);

      await page.getByRole("button", { name: "Settings", exact: true }).first().tap();
      await tall(page.getByRole("button", { name: "App", exact: true }));
      await tall(page.getByRole("searchbox", { name: "Search settings" }).locator(".."));
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest("a desktop page keeps its sizes", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    const row = chats(page).getByRole("button", { name: "Seeded chat 2" });
    expect((await size(row))[1]).toBe(32);
    expect((await size(page.getByRole("button", { name: "What's new" })))[1]).toBe(28);
    expect(realApp.problems).toEqual([]);
  });

  realTest(
    "with an iPad's keyboard ⌘ does what Ctrl does and the keys read ⌘; on Linux that key stays Super (#2775)",
    async ({ realApp, browser }) => {
      // iPadOS's Safari reports a Mac.
      const context = await browser.newContext({
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      });
      const page = await realApp.open({ path: "/", context });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click({ timeout: 120_000 });
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await page.keyboard.press("Meta+Shift+T");
      await expect(page.locator("[data-tab]")).toHaveCount(2);
      await page.keyboard.press("Meta+Slash");
      const sheet = page.getByRole("dialog", { name: "Keys" });
      await expect(sheet.getByText("⌘⇧T", { exact: true })).toBeVisible();
      await context.close();

      const linux = await realApp.open({ path: "/" });
      await chats(linux).getByRole("button", { name: "Seeded chat 1" }).click({ timeout: 120_000 });
      await expect(box(linux)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await linux.keyboard.press("Meta+Shift+T");
      await linux.waitForTimeout(500);
      await expect(linux.locator("[data-tab]")).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    },
  );
});
