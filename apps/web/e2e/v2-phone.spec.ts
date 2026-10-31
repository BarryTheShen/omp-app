import type { BrowserContext, Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI on a phone, on real omp: the message box's key row above the keyboard (the box's settings, and the keys a
 * phone's keyboard lacks), full-size Send and Stop beside the text, one working line without a key to press, and the
 * top bar that names the chat and starts a new one.
 */
realTest.describe("new UI on a phone", () => {
  realTest.setTimeout(240_000);
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const keys = (page: Page) => page.getByRole("toolbar", { name: "Keys" });

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
      await box(page).fill("");
      await keys(page).getByRole("button", { name: "Quick prompts" }).tap();
      await panel.getByRole("tab", { name: "Sent" }).tap();
      await panel.getByRole("button", { name: "Continue" }).tap();
      await expect(box(page)).toHaveValue("Continue");
      expect(realApp.problems).toEqual([]);
      await context.close();
    },
  );

  realTest.describe("with two saved chats", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "the list on a phone: rows without buttons, a touch-and-hold opens a row's menu; New chat, the inbox, Settings and the menu at its foot",
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
        await menu.getByRole("menuitem", { name: "Pin" }).tap();
        await expect(
          list
            .getByRole("region", { name: "Pinned" })
            .getByRole("button", { name: "Seeded chat 1" }),
        ).toBeVisible({ timeout: 30_000 });
        await expect(list).toBeVisible();

        // The theme is in the menu at the list's foot.
        await list.getByRole("button", { name: "Menu" }).tap();
        await page.getByRole("menuitemradio", { name: "Light" }).tap();
        await list.getByRole("button", { name: "Menu" }).tap();
        await expect(page.getByRole("menuitemradio", { name: "Light" })).toBeChecked();
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
      await list.getByRole("button", { name: "Menu" }).tap();
      await page.getByRole("menuitem", { name: "What's new" }).tap();
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
});
