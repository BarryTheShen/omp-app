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
});
