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
      await tall(page.getByRole("button", { name: "New workspace" }).first());
      // The workspaces on top: their tabs and + are a finger's size too.
      await tall(page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab").first());
      await square(page.getByRole("button", { name: "New workspace" }).last());
      await square(page.getByRole("button", { name: "What's new" }));
      await square(page.getByRole("button", { name: "Settings", exact: true }).first());
      await square(page.getByRole("button", { name: "Hide the chat list" }));

      await tall(page.getByRole("button", { name: /^Model: / }));
      await tall(page.getByRole("button", { name: /^Thinking: / }));
      await tall(page.getByRole("button", { name: "Plan", exact: true }));
      await square(page.getByRole("button", { name: "Send" }));
      await square(page.getByRole("button", { name: "Copy this message" }));
      await square(page.getByRole("button", { name: "Usage", exact: true }));
      // The side panel's buttons fit their column, so the page fits the screen and a finger cannot move it sideways
      // (#2810: they were 44 wide in a column of 40).
      const fits = await page.evaluate(() => {
        const rail = document
          .querySelector('nav[aria-label="Side panel"]')
          ?.getBoundingClientRect();
        const buttons = [...document.querySelectorAll('nav[aria-label="Side panel"] button')];
        return {
          pageWider: document.documentElement.scrollWidth - window.innerWidth,
          outside: buttons.filter((button) => {
            const edge = button.getBoundingClientRect();
            return (
              rail === undefined || edge.left < rail.left - 0.5 || edge.right > rail.right + 0.5
            );
          }).length,
        };
      });
      expect(fits).toEqual({ pageWider: 0, outside: 0 });

      await page.keyboard.press("Control+Shift+O");
      // The split is a blank window with the caret on its New chat; its New chat and Close are a finger's size (#2814).
      await square(page.getByRole("button", { name: "Close the window" }));
      await tall(page.locator("[data-new-chat]").last());
      await page.keyboard.press("Enter");
      await expect(box(page)).toHaveCount(2, { timeout: 60_000 });
      await tall(page.locator(".dv-tab").first());
      await square(page.getByRole("button", { name: "Close Seeded chat 1" }));
      // Two panes and a side panel: each pane's model chip gives way, but not below a finger's width.
      await page.getByRole("button", { name: "Files", exact: true }).click();
      const models = page.getByRole("button", { name: /^Model: / });
      await expect(models).toHaveCount(2);
      for (const chip of await models.all()) await square(chip);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "a pane's divider is taken from close to its line, and Settings' rows are a finger's size",
    async ({ realApp, browser }) => {
      const { page, context } = await tablet(realApp, browser);
      await page.keyboard.press("Control+Shift+O");
      await page.keyboard.press("Enter");
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
    "in a short window the chat list keeps room above the What's new card (#2815)",
    async ({ realApp, browser }) => {
      // An iPad's app in a small Stage Manager window: 747 × 519.
      const context = await browser.newContext({
        viewport: { width: 747, height: 519 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      });
      const page = await realApp.open({ path: "/", context });
      const card = page.getByRole("region", { name: "What's new" });
      await expect(card).toBeVisible({ timeout: 120_000 });
      await expect(chats(page).getByRole("button", { name: "Seeded chat 2" })).toBeVisible();
      const list = await page.locator('[data-tour="chat-list"]').boundingBox();
      const whatsNew = await card.boundingBox();
      // At least three rows of the list show, and the card is below them, not over them.
      expect(Math.round(list?.height ?? 0)).toBeGreaterThanOrEqual(132);
      expect(Math.round((list?.y ?? 0) + (list?.height ?? 0))).toBeLessThanOrEqual(
        Math.round(whatsNew?.y ?? 0),
      );
      await expect(
        page.getByRole("button", { name: "Settings", exact: true }).first(),
      ).toBeInViewport();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

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
      await page.keyboard.press("Meta+t");
      await expect(page.locator("[data-tab]")).toHaveCount(2);
      await page.keyboard.press("Meta+Slash");
      const sheet = page.getByRole("dialog", { name: "Keys" });
      await expect(sheet.getByText("⌘O", { exact: true })).toBeVisible();
      await context.close();

      const linux = await realApp.open({ path: "/" });
      await chats(linux).getByRole("button", { name: "Seeded chat 1" }).click({ timeout: 120_000 });
      await expect(box(linux)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await linux.keyboard.press("Meta+t");
      await linux.waitForTimeout(500);
      await expect(linux.locator("[data-tab]")).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "narrowed to Split View, an iPad goes on showing its chat in the phone layout, the list one tap away (#2822)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 2,
      });
      const page = await realApp.open({ path: "/", context });
      // A chat started here (a tap on a list row would mark the chat as shown for a phone layout already).
      await page.getByRole("button", { name: "New chat" }).first().tap({ timeout: 120_000 });
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("stream_steady");
      await box(page).press("Enter");
      const transcript = page.getByRole("region", { name: "Transcript" });
      await expect(transcript.getByText(/Steady line 3:/)).toBeVisible({ timeout: 60_000 });
      // Split View at a half and at a third of the screen: the phone layout.
      for (const width of [590, 375]) {
        await page.setViewportSize({ width, height: 820 });
        await expect(transcript).toBeVisible();
        await expect(box(page)).toBeVisible();
      }
      await page.getByRole("button", { name: /^Chats/ }).tap();
      await expect(chats(page).getByRole("button", { name: /stream_steady/ })).toBeInViewport();
      await page.setViewportSize({ width: 1180, height: 820 });
      await expect(transcript).toBeVisible();
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a phone held sideways (this layout) keeps its message box above the keyboard (#2824)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 874, height: 402 },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 3,
      });
      const page = await realApp.open({ path: "/", context });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).tap({ timeout: 120_000 });
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      // What the page does while iOS's keyboard (209 pt sideways) covers it: it takes the visible height (viewport.ts).
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--app-height", "193px"),
      );
      await expect
        .poll(async () => {
          const bounds = await box(page).boundingBox();
          return bounds === null ? Number.POSITIVE_INFINITY : bounds.y + bounds.height;
        })
        .toBeLessThanOrEqual(193);
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );
});
