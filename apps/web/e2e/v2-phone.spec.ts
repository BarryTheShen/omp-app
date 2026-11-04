import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI on a phone, on real omp: the message box's key row above the keyboard (the box's settings, and the keys a
 * phone's keyboard lacks), full-size Send and Stop beside the text, one working line without a key to press, and the
 * top bar that names the chat and starts a new one.
 */
realTest.describe("new UI on a phone", () => {
  realTest.setTimeout(240_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const keys = (page: Page) => page.getByRole("toolbar", { name: "Keys" });
  /** A sheet's place: its left edge, its width and its bottom edge, in a 390×844 phone. */
  const place = async (sheet: Locator) => {
    const bounds = await sheet.boundingBox();
    return bounds === null
      ? null
      : [Math.round(bounds.x), Math.round(bounds.width), Math.round(bounds.y + bounds.height)];
  };

  async function phone(
    realApp: { open: (options: { path: string; context: BrowserContext }) => Promise<Page> },
    browser: { newContext: (options: object) => Promise<BrowserContext> },
  ): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await realApp.open({ path: "/", context });
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    return { page, context };
  }

  realTest(
    "the key row holds the box's settings and the keys a phone lacks; Send is a full-size target beside the text",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      // The settings left the box for the key row.
      await expect(keys(page).getByRole("button", { name: /^Model: / })).toBeVisible();
      await expect(keys(page).getByRole("button", { name: /^Thinking: / })).toBeVisible();
      await expect(
        page.locator("form[data-tour='message-box']").getByRole("button", { name: /^Model: / }),
      ).toHaveCount(0);
      const send = page.getByRole("button", { name: "Send" });
      expect((await send.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

      // `/` goes in the box as typed, the box keeps the focus, and omp's commands are listed.
      await box(page).tap();
      await keys(page).getByRole("button", { name: "Commands" }).tap();
      await expect(box(page)).toHaveValue("/");
      await expect(box(page)).toBeFocused();

      // A message sent comes back with ↑.
      await box(page).fill("count_reply phone");
      await send.tap();
      await expect(page.getByText("count-1 phone")).toBeVisible({ timeout: 60_000 });
      await keys(page).getByRole("button", { name: "Earlier message" }).tap();
      await expect(box(page)).toHaveValue("count_reply phone");

      // ⌄ puts the keyboard away, and goes with it.
      await box(page).tap();
      const hide = keys(page).getByRole("button", { name: "Hide the keyboard" });
      await hide.tap();
      await expect(box(page)).not.toBeFocused();
      await expect(hide).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "menus are sheets across the foot of the screen, closed by a tap above them; a reply's thinking and tool rows are full-size (#2770)",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const details = await page.getByRole("button", { name: "Details" }).boundingBox();
      if (details === null) throw new Error("no Details button");

      // The model menu, a popover on a computer, is a sheet across the foot of the screen.
      await keys(page)
        .getByRole("button", { name: /^Model: / })
        .tap();
      const sheet = page.locator("[data-slot='popover-content']");
      await expect.poll(() => place(sheet)).toEqual([0, 390, 844]);
      // Its models are full-size rows, and so are their Star and Hide.
      const model = sheet.getByRole("option").first();
      await expect(model).toBeVisible({ timeout: 60_000 });
      expect((await model.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      const star = sheet.getByRole("button", { name: /^(Star|Unstar) / }).first();
      expect((await star.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      // A tap above it closes it, and reaches nothing under it: here the top bar's Details.
      await page.touchscreen.tap(details.x + details.width / 2, details.y + details.height / 2);
      await expect(sheet).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Chat details" })).toHaveCount(0);

      // A reply's thinking and its tool open with a tap: rows 44 px tall or more.
      await box(page).fill("run_bash");
      await page.getByRole("button", { name: "Send" }).tap();
      const tool = page.locator(".tr-root .tv-head").first();
      await expect(tool).toBeVisible({ timeout: 60_000 });
      expect((await tool.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      const thinking = page.locator(".tr-root .tr-think-head").first();
      await expect(thinking).toBeVisible();
      expect((await thinking.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "the return key adds a line and only Send sends (#2769); a long message leaves the chat in view (#2770)",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const transcript = page.getByRole("region", { name: "Transcript" });
      await box(page).tap();
      await page.keyboard.type("first line");
      await page.keyboard.press("Enter");
      await page.keyboard.type("second line");
      await expect(box(page)).toHaveValue("first line\nsecond line");
      await expect(transcript.getByText("first line")).toHaveCount(0);

      // The box stops growing at six lines and scrolls inside, so the chat above stays in view.
      await box(page).fill(Array.from({ length: 30 }, (_, line) => `line ${line + 1}`).join("\n"));
      expect((await box(page).boundingBox())?.height ?? 0).toBeLessThan(200);
      await page.getByRole("button", { name: "Send" }).tap();
      await expect(transcript.getByText("line 30")).toBeVisible({ timeout: 60_000 });
      await expect(box(page)).toHaveValue("");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "while omp works the working line names no key, and Stop is a full-size target",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      await box(page).fill("stream_steady");
      await page.getByRole("button", { name: "Send" }).tap();
      const working = page.getByRole("status").filter({ hasText: /\d+s/ });
      await expect(working).toBeVisible({ timeout: 60_000 });
      await expect(working).not.toContainText("to stop");
      const stop = page.getByRole("button", { name: "Stop" });
      expect((await stop.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      await stop.tap();
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "while omp works, an empty box offers Stop and a typed one Queue, which queues without stopping omp",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      await box(page).fill("slow_tool 20");
      await page.getByRole("button", { name: "Send" }).tap();
      const working = page.getByRole("status").filter({ hasText: /\d+s/ });
      await expect(working).toBeVisible({ timeout: 60_000 });
      const stop = page.getByRole("button", { name: "Stop" });
      const queue = page.getByRole("button", { name: "Queue" });
      await expect(stop).toBeVisible();
      await expect(queue).toHaveCount(0);

      // Typed text turns Stop into Queue, a full-size target; the return key still adds a line.
      await box(page).tap();
      await page.keyboard.type("then say");
      await page.keyboard.press("Enter");
      await page.keyboard.type("done");
      await expect(box(page)).toHaveValue("then say\ndone");
      await expect(queue).toBeVisible();
      await expect(stop).toHaveCount(0);
      expect((await queue.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

      // Queue hands it to omp as Enter does, without ending the reply: the box empties, no Stop takes its place under
      // the finger at once, and the message goes into the chat (a Stop would have put it back in the box).
      await queue.tap();
      await expect(box(page)).toHaveValue("");
      await expect(stop).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Transcript" }).getByText(/then say/),
      ).toBeVisible({
        timeout: 60_000,
      });
      await expect(box(page)).toHaveValue("");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "beside a long plan's pill, the working line's time stays whole, on one line",
    async ({ realApp, browser }) => {
      // A 375-point phone (an iPhone mini): the narrowest, where the pill leaves the line least room.
      const context = await browser.newContext({
        viewport: { width: 375, height: 812 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("make_long_todos");
      await page.getByRole("button", { name: "Send" }).tap();
      const plan = page.getByRole("button", { name: /^Todos: / });
      await expect(plan).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 60_000 });

      await box(page).fill("slow_tool 30");
      await page.getByRole("button", { name: "Send" }).tap();
      // Two digits: the time at its widest before a minute.
      const clock = page.getByRole("status").getByText(/^[1-5]\ds$/);
      await expect(clock).toBeVisible({ timeout: 60_000 });
      const time = await clock.boundingBox();
      const pill = await plan.boundingBox();
      if (time === null || pill === null)
        throw new Error("the time and the plan's pill should be on the screen");
      expect(time.height).toBeLessThan(20);
      expect(time.x + time.width).toBeLessThanOrEqual(pill.x);
      // The pill gave way instead: its task is cut short, and it stays on the screen.
      expect(pill.x + pill.width).toBeLessThanOrEqual(375);
      await page.getByRole("button", { name: "Stop" }).tap();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "the top bar names the chat and starts a new one; Chats goes to the list",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const title = page.getByRole("heading", { level: 1 });
      await expect(title).toHaveText("New chat");
      await box(page).fill("count_reply named");
      await page.getByRole("button", { name: "Send" }).tap();
      await expect(page.getByText("count-1 named")).toBeVisible({ timeout: 60_000 });
      // The chat's name: its first message until omp names it.
      await expect(title).not.toHaveText("New chat", { timeout: 30_000 });

      await page.getByRole("button", { name: "New chat" }).tap();
      await expect(page.getByText("What are we working on?")).toBeVisible({ timeout: 60_000 });
      await expect(title).toHaveText("New chat");
      await expect(box(page)).toHaveValue("");

      await page.getByRole("button", { name: "Chats", exact: true }).tap();
      await expect(page.getByRole("navigation", { name: "Chats" })).toBeVisible();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "⚡ opens the quick panel in the keyboard's place: a tap sends a prompt, a long press puts it in the box, Sent puts a message back",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const panel = page.getByRole("region", { name: "Quick prompts" });
      await box(page).tap();
      await keys(page).getByRole("button", { name: "Quick prompts" }).tap();
      await expect(panel).toBeVisible();
      await expect(box(page)).not.toBeFocused();

      // A tap sends the prompt as it is.
      await panel.getByRole("button", { name: "Continue" }).tap();
      await expect(
        page.getByRole("region", { name: "Transcript" }).getByText("Continue", { exact: true }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(box(page)).toHaveValue("");

      // A press held goes in the box instead, to be changed first; the keyboard takes the panel's place.
      const sure = panel.getByRole("button", { name: "Sure" });
      await expect(sure).toBeEnabled({ timeout: 60_000 });
      await sure.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
      await page.waitForTimeout(700);
      await sure.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
      await expect(box(page)).toHaveValue("Sure");
      await expect(box(page)).toBeFocused();
      await expect(panel).toHaveCount(0);

      // Sent: a message sent before goes back in the box.
      // The box puts its caret after an insert a frame later. A clear before that frame selects all, then the caret
      // lands at the end before the Delete, which leaves the text: wait for the frame (2 runs in 20 did).
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => done(undefined))),
      );
      await box(page).fill("");
      await expect(box(page)).toHaveValue("");
      await keys(page).getByRole("button", { name: "Quick prompts" }).tap();
      await panel.getByRole("tab", { name: "Sent" }).tap();
      await panel.getByRole("button", { name: "Continue" }).tap();
      await expect(box(page)).toHaveValue("Continue");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "Settings on a phone fill the screen: sections as rows with ›, a section opens with ‹ Settings and Done; the theme and What's new are on the App page",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      await page.getByRole("button", { name: "Chats", exact: true }).tap();
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Settings" })
        .tap();
      const sheet = page.getByRole("dialog", { name: "Settings" });
      await expect(sheet).toBeVisible();
      const area = await sheet.boundingBox();
      expect(Math.round(area?.width ?? 0)).toBe(390);
      expect(Math.round(area?.height ?? 0)).toBe(844);
      const sections = sheet.getByRole("navigation", { name: "Settings sections" });
      const heights = await sections
        .getByRole("button")
        .evaluateAll((all) => all.map((row) => row.getBoundingClientRect().height));
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);

      await sections.getByRole("button", { name: "App", exact: true }).tap();
      await expect(sheet.getByRole("region", { name: "App settings" })).toBeVisible();
      await expect(sections).toHaveCount(0);
      const light = sheet
        .getByRole("group", { name: "Theme" })
        .getByRole("button", { name: "Light" });
      await light.tap();
      await expect(light).toHaveAttribute("aria-pressed", "true");
      await sheet.getByRole("button", { name: "Settings", exact: true }).tap();
      await expect(sections).toBeVisible();
      await sheet.getByRole("button", { name: "Done" }).tap();
      await expect(sheet).toBeHidden();

      // What's new opens from the App page: the list has no menu for it.
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Settings" })
        .tap();
      await sheet.getByRole("button", { name: "App", exact: true }).tap();
      await sheet.getByRole("button", { name: "What's new" }).tap();
      await expect(sheet).toBeHidden();
      await expect(page.getByRole("dialog", { name: "What's new" })).toBeVisible();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest.describe("with two saved chats", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "the list on a phone: rows without buttons, a touch-and-hold opens a row's menu; New chat, the inbox and Settings at its foot",
      async ({ realApp, browser }) => {
        const { page, context } = await phone(realApp, browser);
        await page.getByRole("button", { name: "Chats", exact: true }).tap();
        const list = page.getByRole("navigation", { name: "Chats" });
        const row = list.getByRole("button", { name: "Seeded chat 1" });
        await expect(row).toBeVisible();
        await expect(list.getByRole("button", { name: "Pin" })).toHaveCount(0);
        await expect(list.getByRole("group", { name: "Theme" })).toHaveCount(0);
        const newChat = list.getByRole("button", { name: "New chat" });
        await expect(newChat).toHaveCount(1);
        expect((await newChat.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

        // A touch-and-hold opens the row's menu, and opens no chat.
        await row.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
        await page.waitForTimeout(700);
        await row.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeVisible();
        // The menu is a sheet across the foot of the screen, its rows full-size (#2770).
        await expect.poll(() => place(menu)).toEqual([0, 390, 844]);
        for (const item of await menu.getByRole("menuitem").all()) {
          expect((await item.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        await menu.getByRole("menuitem", { name: "Pin" }).tap();
        await expect(
          list
            .getByRole("region", { name: "Pinned" })
            .getByRole("button", { name: "Seeded chat 1" }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(list).toBeVisible();

        // No menu at the list's foot: the theme and What's new are in Settings.
        await expect(list.getByRole("button", { name: "Menu" })).toHaveCount(0);
        // The tours card is one line under the list, its buttons full-size (#2770).
        const card = page.getByRole("region", { name: "What's new" });
        expect((await card.boundingBox())?.height ?? 999).toBeLessThanOrEqual(56);
        expect(
          (await card.getByRole("button", { name: /^Take the tour/ }).boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(44);
        expect(realApp.problems).toEqual([]);
        await context.close();
      },
    );

    realTest(
      "a touch-and-hold on one of your messages opens Copy and Edit; Copy copies it (#2770)",
      async ({ realApp, browser }) => {
        const { page, context } = await phone(realApp, browser);
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.getByRole("button", { name: "Chats", exact: true }).tap();
        await page
          .getByRole("navigation", { name: "Chats" })
          .getByRole("button", { name: "Seeded chat 1" })
          .tap();
        const message = page
          .getByRole("region", { name: "Transcript" })
          .getByText("Seeded chat 1", { exact: true });
        await expect(message).toBeVisible({ timeout: 60_000 });
        // Edit is offered once the chat's omp is ready and idle.
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        // No small buttons under it on a phone.
        await expect(page.getByRole("button", { name: "Copy this message" })).toHaveCount(0);
        await message.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
        await page.waitForTimeout(700);
        await message.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
        const menu = page.getByRole("menu");
        await expect(menu.getByRole("menuitem", { name: "Edit" })).toBeVisible();
        await menu.getByRole("menuitem", { name: "Copy" }).tap();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe("Seeded chat 1");
        expect(realApp.problems).toEqual([]);
        await context.close();
      },
    );

    realTest(
      "an open chat's name in the top bar opens Pin and Rename, as holding its row in the list does",
      async ({ realApp, browser }) => {
        const { page, context } = await phone(realApp, browser);
        const list = page.getByRole("navigation", { name: "Chats" });
        await page.getByRole("button", { name: "Chats", exact: true }).tap();
        await list.getByRole("button", { name: "Seeded chat 1" }).tap();
        const name = page.getByRole("heading", { level: 1 }).getByRole("button", {
          name: "Seeded chat 1",
        });
        await name.tap();
        await page.getByRole("menuitem", { name: "Pin" }).tap();
        await page.getByRole("button", { name: "Chats", exact: true }).tap();
        await expect(
          list
            .getByRole("region", { name: "Pinned" })
            .getByRole("button", { name: "Seeded chat 1" }),
        ).toBeVisible({ timeout: 30_000 });

        await list.getByRole("button", { name: "Seeded chat 1" }).tap();
        await name.tap();
        await page.getByRole("menuitem", { name: "Rename…" }).tap();
        await page.getByRole("textbox", { name: "Chat title" }).fill("A new name");
        await page.getByRole("button", { name: "Rename", exact: true }).tap();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("A new name", {
          timeout: 30_000,
        });
        expect(realApp.problems).toEqual([]);
        await context.close();
      },
    );

    /** A finger on the row's right end, moved `distance` px to the left in steps, then lifted. */
    async function swipeLeft(row: Locator, distance: number): Promise<void> {
      const box = await row.boundingBox();
      if (box === null) throw new Error("the row is not on the page");
      const touch = {
        pointerType: "touch",
        isPrimary: true,
        pointerId: 7,
        clientY: box.y + box.height / 2,
      };
      const x = box.x + box.width - 24;
      await row.dispatchEvent("pointerdown", { ...touch, clientX: x });
      for (let moved = 10; moved <= distance; moved += 10) {
        await row.dispatchEvent("pointermove", { ...touch, clientX: x - moved });
      }
      await row.dispatchEvent("pointerup", { ...touch, clientX: x - distance });
    }

    realTest(
      "a row swiped to the left shows Pin and Delete; Delete still asks, and a short swipe shuts again",
      async ({ realApp, browser }) => {
        const { page, context } = await phone(realApp, browser);
        await page.getByRole("button", { name: "Chats", exact: true }).tap();
        const list = page.getByRole("navigation", { name: "Chats" });
        const rowOf = (title: string) =>
          list.getByRole("listitem").filter({ has: page.getByRole("button", { name: title }) });

        await swipeLeft(list.getByRole("button", { name: "Seeded chat 2" }), 140);
        await rowOf("Seeded chat 2").getByRole("button", { name: "Pin", exact: true }).tap();
        await expect(
          list
            .getByRole("region", { name: "Pinned" })
            .getByRole("button", { name: "Seeded chat 2" }),
        ).toBeVisible({ timeout: 30_000 });

        await swipeLeft(list.getByRole("button", { name: "Seeded chat 1" }), 140);
        await rowOf("Seeded chat 1").getByRole("button", { name: "Delete", exact: true }).tap();
        const confirm = page.getByRole("alertdialog");
        await expect(confirm).toContainText("Delete this chat?");
        await confirm.getByRole("button", { name: "Cancel" }).tap();
        await expect(confirm).toHaveCount(0);

        // Short of half way, the row shuts again: a tap opens its chat, as on any row.
        await swipeLeft(list.getByRole("button", { name: "Seeded chat 1" }), 40);
        await list.getByRole("button", { name: "Seeded chat 1" }).tap();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Seeded chat 1");
        expect(realApp.problems).toEqual([]);
        await context.close();
      },
    );
  });

  realTest(
    "the phone's tour, started from the list, shows the chat and points at the keys, the quick panel and the top bar",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const popover = page.locator(".driver-popover");
      const heading = popover.locator(".driver-popover-title");
      await page.getByRole("button", { name: "Chats", exact: true }).tap();
      const list = page.getByRole("navigation", { name: "Chats" });
      await list.getByRole("button", { name: "Settings" }).tap();
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "App", exact: true })
        .tap();
      await page
        .getByRole("dialog", { name: "Settings" })
        .getByRole("button", { name: "What's new" })
        .tap();
      await page
        .getByRole("dialog", { name: "What's new", exact: true })
        .getByRole("button", { name: "Take the tour: Your phone's controls" })
        .tap();

      // The tour's chat shows, not the list, and its steps point at what they name. The tour's own tab is a second
      // one, so the first tab's chat is still on the page, hidden.
      const shown = (tour: string) =>
        page.locator(`[data-tour='${tour}']`).filter({ visible: true });
      await expect(heading).toHaveText("The keys a phone lacks", { timeout: 30_000 });
      await expect(shown("phone-keys")).toHaveClass(/driver-active-element/);
      await popover.getByRole("button", { name: "Next" }).tap();
      await expect(heading).toHaveText("Quick prompts");
      await keys(page).getByRole("button", { name: "Quick prompts" }).tap();
      await expect(heading).toHaveText("One tap answers");
      await popover.getByRole("button", { name: "Next" }).tap();
      await expect(heading).toHaveText("Your chats");
      await expect(shown("phone-top-bar")).toHaveClass(/driver-active-element/);
      await popover.getByRole("button", { name: "Done" }).tap();
      await expect(popover).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "Settings → App changes this phone's quick prompts, and the starting set comes back",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const list = page.getByRole("navigation", { name: "Chats" });
      const field = page.getByRole("textbox", { name: "Quick prompts" });
      const openAppSettings = async () => {
        await page.getByRole("button", { name: "Chats", exact: true }).tap();
        await list.getByRole("button", { name: "Settings" }).tap();
        await page
          .getByRole("navigation", { name: "Settings sections" })
          .getByRole("button", { name: "App", exact: true })
          .tap();
      };
      await openAppSettings();
      // One a line; empty lines and repeats are dropped when it is saved.
      await field.fill("Ship it\n\nLooks good\nShip it");
      await page.getByRole("button", { name: "Save" }).tap();
      await expect(field).toHaveValue("Ship it\nLooks good");
      await page.keyboard.press("Escape");
      await list.getByRole("button", { name: "New chat" }).tap();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await keys(page).getByRole("button", { name: "Quick prompts" }).tap();
      const panel = page.getByRole("region", { name: "Quick prompts" });
      await expect(panel.getByRole("listitem")).toHaveText(["Ship it", "Looks good"]);

      await openAppSettings();
      await page.getByRole("button", { name: "Use the starting set" }).tap();
      await expect(field).toHaveValue(/^Continue\nSure\n/);
      await page.keyboard.press("Escape");
      await list.getByRole("button", { name: "New chat" }).tap();
      await keys(page).getByRole("button", { name: "Quick prompts" }).tap();
      await expect(panel.getByRole("listitem").first()).toHaveText("Continue");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "a photo is attached from the phone's own picker beside the text (#2783); a desktop page has no such button",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const button = page.getByRole("button", { name: "Attach images" });
      await expect(button).toBeVisible();
      const bounds = await button.boundingBox();
      expect(Math.min(bounds?.width ?? 0, bounds?.height ?? 0)).toBeGreaterThanOrEqual(44);
      // A one-pixel PNG, as the picker would hand it over.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      await page
        .getByLabel("Images to attach")
        .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
      const attached = page.getByRole("list", { name: "Attached images" });
      await expect(attached.getByText("photo.png")).toBeVisible();
      await context.close();

      // A desktop page opens with no chat: a new one brings the message box.
      const desktop = await realApp.open({ path: "/" });
      await startNewChat(desktop);
      await expect(box(desktop)).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
      await expect(desktop.getByRole("button", { name: "Attach images" })).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a phone opens only the chat in front: panes kept behind it open no chat of their own (#2768)",
    async ({ realApp, browser }) => {
      // Three panes side by side, each a new chat, made at a tablet's width, where Ctrl+Shift+O splits.
      const context = await browser.newContext({
        viewport: { width: 1280, height: 844 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      for (const panes of [2, 3]) {
        await page.keyboard.press("Control+Shift+O");
        // The split is a blank window with the caret on its New chat.
        await page.keyboard.press("Enter");
        await expect(page.locator("[data-chat-pane]")).toHaveCount(panes);
      }
      await expect(box(page)).toHaveCount(3);
      for (const each of await box(page).all())
        await expect(each).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await page.waitForTimeout(1_000);

      // The same browser as a phone: it comes back with its panes, but only the chat in front opens. Counted from the
      // page's new connection: the open calls it sends.
      let opens = 0;
      page.on("websocket", (socket) =>
        socket.on("framesent", ({ payload }) => {
          const text = typeof payload === "string" ? payload : payload.toString("utf8");
          if (text.includes('"port":"A0.chatSession"') && text.includes('"method":"open"')) opens++;
        }),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await page.waitForTimeout(3_000);
      expect(opens).toBe(1);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "a message sent as the phone comes back, on a link that died while it slept, goes within seconds (#2808)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      // The page away from the screen and back, as the browser tells it.
      await context.addInitScript(() => {
        let hidden = false;
        Object.defineProperty(document, "visibilityState", {
          get: () => (hidden ? "hidden" : "visible"),
          configurable: true,
        });
        Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden = (on) => {
          hidden = on;
          document.dispatchEvent(new Event("visibilitychange"));
        };
      });
      // A link that dies while the phone sleeps stays open on the page and carries nothing either way.
      const links: { dead: boolean }[] = [];
      await context.routeWebSocket(/\/ws\?/, (socket) => {
        const server = socket.connectToServer();
        const link = { dead: false };
        links.push(link);
        socket.onMessage((message) => {
          if (!link.dead) server.send(message);
        });
        server.onMessage((message) => {
          if (!link.dead) socket.send(message);
        });
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("count_reply first");
      await page.getByRole("button", { name: "Send" }).tap();
      await expect(page.getByText("count-1 first")).toBeVisible({ timeout: 60_000 });

      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(true),
      );
      for (const link of links) link.dead = true;
      await page.waitForTimeout(6_000);
      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(false),
      );

      // Sent at once: it waits for the app to find the link dead and open a new one, then goes.
      await box(page).fill("count_reply now");
      await page.getByRole("button", { name: "Send" }).tap();
      await expect(page.getByText("count-2 now")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/^Not sent/)).toHaveCount(0);
      await expect(box(page)).toHaveValue("");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "a phone locked right after a chat opened reads the chat's subagents again on the new link, with no warning (#2813)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      await context.addInitScript(() => {
        let hidden = false;
        Object.defineProperty(document, "visibilityState", {
          get: () => (hidden ? "hidden" : "visible"),
          configurable: true,
        });
        Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden = (on) => {
          hidden = on;
          document.dispatchEvent(new Event("visibilitychange"));
        };
      });
      // The first link dies as the chat's setup asks for its subagents: that read and the rest of the setup are lost.
      const links: { dead: boolean; asked: number }[] = [];
      await context.routeWebSocket(/\/ws\?/, (socket) => {
        const server = socket.connectToServer();
        const link = { dead: false, asked: 0 };
        links.push(link);
        socket.onMessage((message) => {
          if (String(message).includes('"method":"setSubagentSubscription"')) {
            link.asked += 1;
            if (links.length === 1) link.dead = true;
          }
          if (!link.dead) server.send(message);
        });
        server.onMessage((message) => {
          if (!link.dead) socket.send(message);
        });
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await expect.poll(() => links[0]?.dead ?? false, { timeout: 30_000 }).toBe(true);

      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(true),
      );
      await page.waitForTimeout(6_000);
      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(false),
      );
      // The app finds the link dead and opens another; the setup's read goes again on it.
      await expect.poll(() => links[1]?.asked ?? 0, { timeout: 15_000 }).toBe(1);
      await page.waitForTimeout(1_000);
      await expect(page.getByText(/subagents are not shown/)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "a message typed while the chat opens is sent by Send once the chat is open, as Enter does on a computer",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      // A slow link: the chat's open answers 5 s late.
      await context.routeWebSocket(/\/ws\?/, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          if (String(message).includes('"method":"open"'))
            setTimeout(() => server.send(message), 5_000);
          else server.send(message);
        });
        server.onMessage((message) => socket.send(message));
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", "Opening the chat…", {
        timeout: 60_000,
      });
      await box(page).fill("count_reply early");
      // Tapped at once: before the chat is open, which the button does not wait for.
      await page.getByRole("button", { name: "Send" }).tap({ force: true });
      await expect(
        page.getByRole("status").filter({ hasText: "Sends once the chat is open" }),
      ).toBeVisible();
      await expect(page.getByText(/count-\d+ early/)).toBeVisible({ timeout: 60_000 });
      await expect(box(page)).toHaveValue("");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
