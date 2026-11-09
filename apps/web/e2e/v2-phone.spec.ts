import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI on a phone, on real omp: ＋ and ⚡ and full-size Send and Stop beside the text, nothing between the box and
 * the keyboard, one working line without a key to press, and the top bar that names the chat and starts a new one.
 */
realTest.describe("new UI on a phone", () => {
  realTest.setTimeout(240_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  /** The box once the chat is open: on a phone it names the model and its level; before omp names one, "Message omp". */
  const ready = /^(Fake Model|Message omp)/;
  /** ⚡ beside Send: it opens the quick prompts in the keyboard's place. */
  const zap = (page: Page) =>
    page.locator("[data-tour='message-box']").getByRole("button", { name: "Quick prompts" });
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
    await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
    return { page, context };
  }

  realTest(
    "＋ holds the box's settings, files and quick prompts; the empty box names the model and its level; Send is a full-size target beside the text (#2837)",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      // The model and its level are behind ＋, and the empty box names them.
      await expect(box(page)).toHaveAttribute("placeholder", "Fake Model · high");
      await expect(page.getByRole("button", { name: /^Model: / })).toHaveCount(0);
      const send = page.getByRole("button", { name: "Send" });
      expect((await send.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

      // ＋ holds the rest: files, the quick prompts, and the box's settings.
      await page.getByRole("button", { name: "More" }).tap();
      const plus = page.locator("[data-tour='plus-sheet']");
      await expect(plus.getByRole("button", { name: "Photo or file" })).toBeVisible();
      await expect(plus.getByRole("button", { name: "Quick prompts" })).toBeVisible();
      await expect(plus.getByRole("button", { name: /^Model: / })).toBeVisible();
      await expect(plus.getByRole("button", { name: /^Thinking: / })).toBeVisible();
      await expect(plus.getByRole("button", { name: "Plan", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(plus).toHaveCount(0);
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

      // The model menu, a popover on a computer, is a sheet across the foot of the screen, over ＋'s.
      await page.getByRole("button", { name: "More" }).tap();
      const plus = page.locator("[data-tour='plus-sheet']");
      await plus.getByRole("button", { name: /^Model: / }).tap();
      const sheet = page.locator("[data-slot='popover-content'][data-tour='model-menu']");
      await expect(sheet).toBeVisible();
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
      // ＋'s sheet under it closes as any sheet does.
      if ((await plus.count()) > 0) await page.keyboard.press("Escape");
      await expect(plus).toHaveCount(0);

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
    "Send sits in the one-line box with the same room above, below and to its right, and the box is no taller",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      await box(page).fill("hello");
      const form = await page.locator("[data-tour='message-box']").boundingBox();
      const send = await page.getByRole("button", { name: "Send" }).boundingBox();
      if (form === null || send === null) throw new Error("the box is not drawn");
      const above = send.y - form.y;
      const below = form.y + form.height - (send.y + send.height);
      const right = form.x + form.width - (send.x + send.width);
      expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
      expect(Math.abs(right - below)).toBeLessThanOrEqual(1);
      // A finger's 44 pt, and the box as tall as before: the even room costs the chat nothing.
      expect(send.height).toBeGreaterThanOrEqual(44);
      expect(form.height).toBeLessThanOrEqual(52);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "⚡ sits beside Send, and a tap on the box brings nothing up between it and the keyboard",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      // The keyboard has / @ and !: a tap on the box moves nothing, and no row comes up under it.
      const form = page.locator("[data-tour='message-box']");
      const before = await form.boundingBox();
      await box(page).tap();
      await page.evaluate(
        () =>
          new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(0)))),
      );
      expect(await form.boundingBox()).toEqual(before);
      await expect(box(page)).toBeFocused();

      await box(page).fill("hello");
      const quick = await zap(page).boundingBox();
      const send = await page.getByRole("button", { name: "Send" }).boundingBox();
      if (quick === null || send === null) throw new Error("the box is not drawn");
      // Right before Send, on its line, a finger's size.
      expect(quick.x + quick.width).toBeLessThanOrEqual(send.x);
      expect(send.x - (quick.x + quick.width)).toBeLessThanOrEqual(8);
      expect(Math.abs(quick.y + quick.height / 2 - (send.y + send.height / 2))).toBeLessThanOrEqual(
        1,
      );
      expect(Math.min(quick.width, quick.height)).toBeGreaterThanOrEqual(44);

      // ⚡ puts the quick prompts in the keyboard's place, and ⌨ in its place brings the keyboard back.
      await zap(page).tap();
      const panel = page.getByRole("region", { name: "Quick prompts" });
      await expect(panel).toBeVisible();
      await expect(box(page)).not.toBeFocused();
      await page
        .locator("[data-tour='message-box']")
        .getByRole("button", { name: "Keyboard", exact: true })
        .tap();
      await expect(panel).toHaveCount(0);
      await expect(box(page)).toBeFocused();
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
    "omp's plan shows in the top bar, not in a row above the box; a tap there opens the chat's Progress (#2837)",
    async ({ realApp, browser }) => {
      // A 375-point phone (an iPhone mini): the narrowest.
      const context = await browser.newContext({
        viewport: { width: 375, height: 812 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      const topBar = page.locator('[data-tour="phone-top-bar"]');
      // Nothing kept yet: the top bar has ⓘ.
      await expect(topBar.getByRole("button", { name: "Details", exact: true })).toBeVisible();
      await box(page).fill("make_long_todos");
      await page.getByRole("button", { name: "Send" }).tap();
      const plan = topBar.getByRole("button", { name: /^Todos: 0 of 4 done, now: .*\. Details$/ });
      await expect(plan).toBeVisible({ timeout: 60_000 });
      await expect(plan).toHaveText("0/4");
      await expect(topBar.getByRole("button", { name: "Details", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 60_000 });
      // No pill above the message box, also while omp works, and the working line's time stays whole.
      const composer = page.locator(".composer-foot");
      await box(page).fill("slow_tool 30");
      await page.getByRole("button", { name: "Send" }).tap();
      const clock = page.getByRole("status").getByText(/^[1-5]\ds$/);
      await expect(clock).toBeVisible({ timeout: 60_000 });
      expect((await clock.boundingBox())?.height ?? 99).toBeLessThan(20);
      await expect(composer.getByRole("button", { name: /^Todos: / })).toHaveCount(0);
      const bar = await topBar.boundingBox();
      const button = await plan.boundingBox();
      expect((button?.x ?? 0) + (button?.width ?? 999)).toBeLessThanOrEqual(375);
      expect(button?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(bar?.height ?? 0).toBe(44);

      // The top bar's button opens the chat's details at Progress, with the plan.
      await plan.tap();
      await expect(page.getByRole("tab", { name: "Progress", selected: true })).toBeVisible();
      await expect(
        page.getByRole("tabpanel", { name: "Progress" }).getByText("Ship the update"),
      ).toBeVisible();
      await page.getByRole("button", { name: "Chat", exact: true }).tap();
      await page.getByRole("button", { name: "Stop" }).tap();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "a chat's agents show in the top bar while they run; with no plan a tap opens the chat's Agents (#2837)",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      await box(page).fill("spawn_long_subagent");
      await page.getByRole("button", { name: "Send" }).tap();
      const topBar = page.locator('[data-tour="phone-top-bar"]');
      const agents = topBar.getByRole("button", { name: /agents? running\. Details$/ });
      await expect(agents).toBeVisible({ timeout: 60_000 });
      await expect(
        page.locator(".composer-foot").getByRole("button", { name: /running/ }),
      ).toHaveCount(0);
      await agents.tap();
      await expect(page.getByRole("tab", { name: "Agents", selected: true })).toBeVisible();
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
      await zap(page).tap();
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
      await zap(page).tap();
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
      // Measured once it has opened: the sheet zooms in from 95 % over 220 ms, and a box read during that is smaller.
      const size = async (): Promise<string> => {
        const area = await sheet.boundingBox();
        return `${Math.round(area?.width ?? 0)}x${Math.round(area?.height ?? 0)}`;
      };
      await expect.poll(size).toBe("390x844");
      // Its last frames round to the full size while a row is still a fraction of a pixel short: the zoom ends first.
      await sheet.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
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

  realTest(
    "Settings on a phone search as you type: the field keeps each letter and stays, the results show under it; emptied, the sections come back",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      await page.getByRole("button", { name: "Chats", exact: true }).tap();
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Settings" })
        .tap();
      const sheet = page.getByRole("dialog", { name: "Settings" });
      const sections = sheet.getByRole("navigation", { name: "Settings sections" });
      await expect(sections).toBeVisible();
      const search = sheet.getByRole("searchbox", { name: "Search settings" });
      await search.tap();
      // One key at a time, as a phone's keyboard types: every letter goes into the same field.
      await search.pressSequentially("retry", { delay: 40 });
      await expect(search).toHaveValue("retry");
      await expect(search).toBeFocused();
      await expect(sheet.getByRole("region", { name: "Search results" })).toContainText(
        "Retry Attempts",
      );
      await expect(sections).toHaveCount(0);
      // Where a change goes shows with the results, as it does over a section.
      await expect(sheet.getByRole("group", { name: "Whose settings" })).toBeVisible();

      await search.fill("");
      await expect(sections).toBeVisible();
      await expect(search).toBeFocused();
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  /**
   * What a finger can tap inside `scope` that is under 44 high, or under 44 wide when it is only an icon (#2816). A row
   * around a control (a label) is its target, and so is the area shadcn draws around a tick box, a switch or a round
   * mark (its `::after`).
   */
  const smallTargets = (scope: Locator): Promise<string[]> =>
    scope.evaluate((root) => {
      const tappable =
        'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="switch"], ' +
        '[role="checkbox"], [role="radio"], [role="tab"], [role="combobox"]';
      const small: string[] = [];
      for (const element of root.querySelectorAll(tappable)) {
        const box = element.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || element.closest('[aria-hidden="true"], [inert]'))
          continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.pointerEvents === "none") continue;
        const id = element.getAttribute("id");
        const label =
          element.closest("label") ??
          (id === null ? null : document.querySelector(`label[for="${CSS.escape(id)}"]`));
        const row = label?.getBoundingClientRect();
        const after = getComputedStyle(element, "::after");
        const around = (start: string, end: string, size: number): number =>
          after.position === "absolute"
            ? size - Number.parseFloat(start) - Number.parseFloat(end)
            : 0;
        const height = Math.max(
          box.height,
          row?.height ?? 0,
          around(after.top, after.bottom, box.height),
        );
        const width = Math.max(
          box.width,
          row?.width ?? 0,
          around(after.left, after.right, box.width),
        );
        const icon = (element.textContent ?? "").trim() === "";
        if (height >= 43.5 && (!icon || width >= 43.5)) continue;
        const name = (element.getAttribute("aria-label") ?? element.textContent ?? "")
          .trim()
          .slice(0, 30);
        small.push(`${name} ${Math.round(width)}×${Math.round(height)}`);
      }
      return small;
    });

  realTest(
    "everything you tap outside the chat is 44 pt or more: the list, Settings, the Details panels and a question (#2816)",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const list = page.getByRole("navigation", { name: "Chats" });
      await page.getByRole("button", { name: "Chats", exact: true }).tap();
      await expect(list).toBeVisible();
      expect(await smallTargets(list)).toEqual([]);

      await list.getByRole("button", { name: "Settings" }).tap();
      const sheet = page.getByRole("dialog", { name: "Settings" });
      const sections = sheet.getByRole("navigation", { name: "Settings sections" });
      for (const section of ["Appearance", "App"]) {
        await sections.getByRole("button", { name: section, exact: true }).tap();
        // omp's sections show their name as a heading; the app's own section is its region.
        await expect(
          sheet
            .getByRole("heading", { name: section, exact: true })
            .or(sheet.getByRole("region", { name: `${section} settings` }))
            .first(),
        ).toBeVisible();
        expect(await smallTargets(sheet), section).toEqual([]);
        await sheet.getByRole("button", { name: "Settings", exact: true }).tap();
      }
      await sheet.getByRole("button", { name: "Done" }).tap();

      await page.getByRole("button", { name: "New chat" }).first().tap();
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await page.getByRole("button", { name: "Details" }).tap();
      const details = page.getByRole("region", { name: "Chat details" });
      for (const panel of ["Progress", "Files"]) {
        await details.getByRole("tab", { name: panel }).tap();
        await expect(details.getByRole("tabpanel", { name: panel })).toBeVisible();
        expect(await smallTargets(details), panel).toEqual([]);
      }
      await details.getByRole("button", { name: "Chat", exact: true }).tap();

      await box(page).fill("ask_user");
      await page.getByRole("button", { name: "Send" }).tap();
      const questions = page.getByRole("dialog", { name: "Questions from omp" });
      await expect(questions).toBeVisible({ timeout: 60_000 });
      expect(await smallTargets(questions)).toEqual([]);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest("a computer keeps its denser controls (#2816)", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    const search = page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("searchbox", { name: "Search chats" });
    await expect(search).toBeVisible({ timeout: 60_000 });
    const height = await search.evaluate(
      (input) => input.closest("label")?.getBoundingClientRect().height,
    );
    expect(height).toBe(32);
    expect(realApp.problems).toEqual([]);
  });

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
        await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
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
    "the phone's tour, started from the list, shows the chat and points at ⚡, the quick panel, ＋ and the top bar",
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
      // The tour asks for a tap on ⚡, never its Next, so the quick panel is open for the step after.
      await expect(heading).toHaveText("Your quick prompts", { timeout: 30_000 });
      await expect(shown("quick-prompts-key")).toHaveClass(/driver-active-element/);
      await shown("quick-prompts-key").tap();
      await expect(heading).toHaveText("One tap answers");
      await popover.getByRole("button", { name: "Next" }).tap();
      await expect(heading).toHaveText("＋ for the rest");
      await expect(shown("plus")).toHaveClass(/driver-active-element/);
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
      await page.getByRole("button", { name: "Save", exact: true }).tap();
      await expect(field).toHaveValue("Ship it\nLooks good");
      await page.keyboard.press("Escape");
      await list.getByRole("button", { name: "New chat" }).tap();
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await zap(page).tap();
      const panel = page.getByRole("region", { name: "Quick prompts" });
      await expect(panel.getByRole("listitem")).toHaveText(["Ship it", "Looks good"]);

      await openAppSettings();
      await page.getByRole("button", { name: "Use the starting set" }).tap();
      await expect(field).toHaveValue(/^Continue\nSure\n/);
      await page.keyboard.press("Escape");
      await list.getByRole("button", { name: "New chat" }).tap();
      await box(page).tap();
      await zap(page).tap();
      await expect(panel.getByRole("listitem").first()).toHaveText("Continue");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest(
    "＋'s Photo or file takes a photo or any file from the phone's own picker (#2783, #2830, #2837), with targets of 44 pt",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      const plus = page.getByRole("button", { name: "More" });
      const bounds = await plus.boundingBox();
      expect(Math.min(bounds?.width ?? 0, bounds?.height ?? 0)).toBeGreaterThanOrEqual(44);
      await plus.tap();
      const row = page
        .locator("[data-tour='plus-sheet']")
        .getByRole("button", { name: "Photo or file" });
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
      // The row opens the phone's own picker, which is not limited to pictures: an iPhone offers the photo library, the
      // camera and Files.
      const picker = page.getByLabel("Files to attach");
      expect(await picker.getAttribute("accept")).toBeNull();
      const chooser = page.waitForEvent("filechooser");
      await row.tap();
      const opened = await chooser;
      await expect(page.locator("[data-tour='plus-sheet']")).toHaveCount(0);
      // A one-pixel PNG and a small PDF, as the picker would hand them over.
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      await opened.setFiles([
        { name: "photo.png", mimeType: "image/png", buffer: png },
        { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") },
      ]);
      const attached = page.getByRole("list", { name: "Attachments" });
      await expect(attached.getByText("photo.png")).toBeVisible();
      // The PDF is uploaded to the chat's folder: its chip shows its size once it is up.
      await expect(attached.getByRole("listitem").filter({ hasText: "report.pdf" })).toContainText(
        "13 B",
        { timeout: 30_000 },
      );
      // Sizes are read until they settle: a chip and a sent message are drawn again as their file and the reply come in.
      const remove = page.getByRole("button", { name: "Remove report.pdf" });
      await expect
        .poll(async () => {
          const bounds = await remove.boundingBox();
          return Math.min(bounds?.width ?? 0, bounds?.height ?? 0);
        })
        .toBeGreaterThanOrEqual(44);

      await box(page).fill("hello");
      await page.getByRole("button", { name: "Send" }).tap();
      const sent = page
        .getByRole("region", { name: "Transcript" })
        .getByRole("button", { name: "Download report.pdf" });
      await expect(sent).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(async () => (await sent.boundingBox())?.height ?? 0)
        .toBeGreaterThanOrEqual(44);
      await expect(attached).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
      await context.close();
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
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      for (const panes of [2, 3]) {
        await page.keyboard.press("Control+Shift+O");
        // The split is a blank window with the caret on its New chat.
        await page.keyboard.press("Enter");
        await expect(page.locator("[data-chat-pane]")).toHaveCount(panes);
      }
      await expect(box(page)).toHaveCount(3);
      for (const each of await box(page).all())
        await expect(each).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
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
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
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
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
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
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
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

  realTest(
    "the 'app was updated' banner leaves the top bar's controls in reach (#2818)",
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
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden = (on) => {
          hidden = on;
          document.dispatchEvent(new Event("visibilitychange"));
        };
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      // A new build goes live: the app's page names another entry script.
      await page.route(/\/$/, async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace(
          /\/assets\/index-[\w-]+\.js/,
          "/assets/index-next.js",
        );
        await route.fulfill({ response, body: html });
      });
      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(true),
      );
      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(false),
      );
      await expect(page.getByRole("status").filter({ hasText: "The app was updated" })).toBeVisible(
        {
          timeout: 30_000,
        },
      );
      const covered = await page.evaluate(() =>
        [...document.querySelectorAll('[data-tour="phone-top-bar"] button')].flatMap((button) => {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return button.contains(hit)
            ? []
            : [button.getAttribute("aria-label") ?? button.textContent];
        }),
      );
      expect(covered).toEqual([]);
      await page.unroute(/\/$/);
      await context.close();
    },
  );

  realTest(
    "the update banner's Reload, and any load within an hour of the app last being up, come back to the chat that was open; a load after longer opens on a new chat (#2819)",
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
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden = (on) => {
          hidden = on;
          document.dispatchEvent(new Event("visibilitychange"));
        };
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await box(page).fill("count_reply kept");
      await page.getByRole("button", { name: "Send" }).tap();
      const reply = page.getByRole("region", { name: "Transcript" }).getByText(/count-\d+ kept/);
      await expect(reply).toBeVisible({ timeout: 60_000 });

      // A new build goes live; the banner's Reload.
      await page.route(/\/$/, async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace(
          /\/assets\/index-[\w-]+\.js/,
          "/assets/index-next.js",
        );
        await route.fulfill({ response, body: html });
      });
      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(true),
      );
      await page.evaluate(() =>
        (window as unknown as { setHidden: (on: boolean) => void }).setHidden(false),
      );
      const banner = page.getByRole("status").filter({ hasText: "The app was updated" });
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await page.unroute(/\/$/);
      await banner.getByRole("button", { name: "Reload" }).tap();
      await expect(reply).toBeVisible({ timeout: 120_000 });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 60_000 });

      // Opened again by itself within the hour (iOS reloads a Home Screen app it put away): back to the same chat.
      await page.reload();
      await expect(reply).toBeVisible({ timeout: 120_000 });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 60_000 });

      // Opened again two hours after the app was last up: a new chat, as a launch.
      await context.addInitScript(() =>
        localStorage.setItem("omp-app:last-up", String(Date.now() - 2 * 60 * 60 * 1000)),
      );
      await page.reload();
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      await expect(reply).toHaveCount(0);
      await context.close();
    },
  );

  realTest(
    "a tour about the chat, started from What's new on a phone, brings the chat in front and points at its button (#2823)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", ready, { timeout: 120_000 });
      // On a phone What's new is in Settings → App, reached from the list.
      await page.getByRole("button", { name: "Chats", exact: true }).tap();
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Settings" })
        .tap();
      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.getByRole("button", { name: "App", exact: true }).tap();
      await settings.getByRole("button", { name: "What's new" }).tap();
      await page.getByRole("button", { name: "Take the tour: Stop, or queue" }).tap();
      await expect(page.locator(".driver-popover")).toContainText("One button, three jobs");
      const highlighted = page.locator(".driver-active-element");
      await expect(highlighted).toHaveAttribute("data-tour", "send-button");
      await expect(highlighted).toBeInViewport();
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "the strips behind the status bar and the home bar take the screen's colour, the chat starts right under the status bar and the chat list below the band iOS blurs, and no empty band is left above or below the chat",
    async ({ realApp, browser }) => {
      const { page, context } = await phone(realApp, browser);
      // An iPhone's status bar and home bar (62 at the top, 34 at the bottom), through the app's own variables: a test
      // browser has none.
      await page.addStyleTag({
        content: ":root{--status-inset:62px!important;--safe-bottom:34px!important}",
      });
      await box(page).fill("count_reply bands");
      await page.getByRole("button", { name: "Send" }).tap();
      await expect(page.getByText("count-1 bands")).toBeVisible({ timeout: 60_000 });
      const shown = await page.evaluate(() => {
        const edge = (selector: string) =>
          document.querySelector(selector)?.getBoundingClientRect();
        const form = edge('[data-tour="message-box"]');
        const strip = getComputedStyle(document.getElementById("root") as Element, "::before");
        return {
          chat: getComputedStyle(document.querySelector("main") as Element).backgroundColor,
          top: strip.backgroundColor,
          bottom: getComputedStyle(document.body).backgroundColor,
          // The chat takes the room iOS blurs under the status bar: its top bar starts right under it, and the strip
          // covers the status bar alone.
          barTop: Math.round(edge('[data-tour="phone-top-bar"]')?.top ?? 0),
          stripHeight: Math.round(Number.parseFloat(strip.height)),
          // The first message right under the top bar (its row keeps its own spacing), and with the keyboard down the
          // box, the lowest thing on the screen, right on the home bar's strip.
          aboveChat: Math.round(
            (edge('[data-index="0"]')?.top ?? 0) -
              (edge('[data-tour="phone-top-bar"]')?.bottom ?? 0),
          ),
          belowBox: Math.round(window.innerHeight - 34 - (form?.bottom ?? 0)),
        };
      });
      expect(shown).toEqual({
        chat: shown.chat,
        top: shown.chat,
        bottom: shown.chat,
        barTop: 62,
        stripHeight: 62,
        aboveChat: 0,
        belowBox: 0,
      });

      // The chat list starts 20 px lower, below the band iOS blurs (about 35 pt under the status bar), with its own
      // 8 px of room above its first row.
      await page.getByRole("button", { name: "Chats", exact: true }).tap();
      const list = page.getByRole("navigation", { name: "Chats" });
      await expect(list).toBeVisible();
      expect(
        await list.evaluate((nav) =>
          Math.round(nav.firstElementChild?.getBoundingClientRect().top ?? 0),
        ),
      ).toBe(90);

      // Settings covers the screen: the strip over its top takes its colour.
      await page
        .getByRole("navigation", { name: "Chats" })
        .getByRole("button", { name: "Settings" })
        .tap();
      const sheet = page.getByRole("dialog", { name: "Settings" });
      await expect(sheet).toBeVisible();
      const settings = await sheet.evaluate((element) => ({
        sheet: getComputedStyle(element).backgroundColor,
        top: getComputedStyle(document.getElementById("root") as Element, "::before")
          .backgroundColor,
      }));
      expect(settings.top).toBe(settings.sheet);
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );
});
