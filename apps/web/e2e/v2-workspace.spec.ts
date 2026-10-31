import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI's workspace (`apps/ui`, under `/v2/`) on real omp: kitty's panes and tabs with kitty's keys, the
 * sidebar opening chats into panes, layouts kept across a reload, and one pane on a phone.
 */
realTest.describe("new UI workspace", () => {
  realTest.setTimeout(240_000);
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const opened = async (page: Page, count: number) => {
    await expect(boxes(page)).toHaveCount(count, { timeout: 60_000 });
    for (let index = 0; index < count; index += 1)
      await expect(boxes(page).nth(index)).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
  };

  realTest(
    "splits, zoom, moving between panes and closing one with kitty's keys; the panes come back after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      // An empty tab offers a chat of its own, beside the list's.
      await expect(page.getByRole("main").getByRole("button", { name: "New chat" })).toBeVisible();
      await chats(page).getByRole("button", { name: "New chat" }).click();
      await opened(page, 1);
      await boxes(page).first().click();

      await page.keyboard.press("Control+Shift+O");
      await opened(page, 2);
      await expect(boxes(page).nth(1)).toBeFocused();
      await page.keyboard.press("Control+Shift+E");
      await opened(page, 3);
      await expect(boxes(page).nth(2)).toBeFocused();

      await page.keyboard.press("Meta+Control+ArrowLeft");
      await expect(boxes(page).nth(0)).toBeFocused();
      await page.keyboard.type("only in the left pane");

      await page.keyboard.press("Control+Shift+Enter");
      await expect(boxes(page).filter({ visible: true })).toHaveCount(1);
      await expect(boxes(page).filter({ visible: true })).toHaveValue("only in the left pane");
      await page.keyboard.press("Control+Shift+Enter");
      await expect(boxes(page).filter({ visible: true })).toHaveCount(3);

      await page.keyboard.press("Meta+Control+BracketRight");
      await expect(boxes(page).nth(0)).not.toBeFocused();
      await page.keyboard.press("Meta+Control+ArrowLeft");
      await expect(boxes(page).nth(0)).toBeFocused();
      await page.keyboard.press("Control+Shift+W");
      await expect(boxes(page)).toHaveCount(2);

      await page.reload();
      await opened(page, 2);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "tabs: a new tab with a new chat, rename, move, next and close; the tabs come back after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await chats(page).getByRole("button", { name: "New chat" }).click();
      await opened(page, 1);
      await boxes(page).first().click();
      const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");

      await page.keyboard.press("Control+Shift+T");
      await expect(tabs).toHaveCount(2);
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(boxes(page).filter({ visible: true })).toHaveCount(1);
      await expect(boxes(page).filter({ visible: true })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 120_000 },
      );

      await page.keyboard.press("Control+Shift+Alt+T");
      const name = page.getByRole("textbox", { name: "Tab name" });
      await expect(name).toBeFocused();
      await name.fill("Parser work");
      await name.press("Enter");
      await expect(tabs.nth(1)).toHaveText("Parser work");

      await boxes(page).filter({ visible: true }).click();
      await page.keyboard.press("Control+Shift+Comma");
      await expect(tabs.nth(0)).toHaveText("Parser work");
      await page.keyboard.press("Control+Tab");
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Control+Shift+Q");
      await expect(tabs).toHaveCount(0);

      await boxes(page).filter({ visible: true }).click();
      await page.keyboard.press("Control+Shift+T");
      await expect(tabs).toHaveCount(2);
      await page.reload();
      await expect(tabs).toHaveCount(2, { timeout: 60_000 });
      await expect(tabs.nth(0)).toHaveText("Parser work");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("with two saved chats", () => {
    realTest.use({ seedSessions: 2 });

    realTest(
      "a click opens a chat in the focused pane, Alt+click beside it, and an open chat gets the focus",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        const first = chats(page).getByRole("button", { name: "Seeded chat 1" });
        const second = chats(page).getByRole("button", { name: "Seeded chat 2" });

        await first.click();
        await opened(page, 1);
        await expect(first).toHaveAttribute("aria-current", "true");
        await expect(first).toHaveAccessibleName("Seeded chat 1, open in a pane");

        await second.click({ modifiers: ["Alt"] });
        await opened(page, 2);
        await expect(second).toHaveAttribute("aria-current", "true");
        await expect(boxes(page).nth(1)).toBeFocused();

        await first.click();
        await expect(boxes(page)).toHaveCount(2);
        await expect(first).toHaveAttribute("aria-current", "true");
        await expect(boxes(page).nth(0)).toBeFocused();

        // New chat takes the focused pane: chat 1 is no longer open.
        await chats(page).getByRole("button", { name: "New chat" }).click();
        await expect(boxes(page)).toHaveCount(2);
        await expect(first).toHaveAccessibleName("Seeded chat 1");
        await expect(second).toHaveAccessibleName("Seeded chat 2, open in a pane");

        expect(realApp.problems).toEqual([]);
      },
    );

    realTest("a phone shows the list or one chat", async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page.setViewportSize({ width: 390, height: 844 });
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(chats(page)).toBeHidden();
      await expect(boxes(page).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
      await page.getByRole("button", { name: "Chats", exact: true }).click();
      await chats(page)
        .getByRole("button", { name: "Seeded chat 2" })
        .click({ modifiers: ["Alt"] });
      // Two panes, but the phone shows only the one in front (the other is hidden, out of the page's roles).
      await expect(page.getByRole("textbox", { name: "Message", includeHidden: true })).toHaveCount(
        2,
        { timeout: 60_000 },
      );
      await expect(boxes(page)).toHaveCount(1);
      await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      expect(realApp.problems).toEqual([]);
    });

    realTest(
      "a phone opens on a new chat with the list a tap away, and on a new chat again when opened again",
      async ({ realApp, browser }) => {
        const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await realApp.open({ path: "/", context: phone });
        const welcome = page.getByText("What are we working on?");
        // The chat, not the list: a new one, ready to type.
        await expect(chats(page)).toBeHidden();
        await expect(boxes(page)).toHaveCount(1, { timeout: 60_000 });
        await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await expect(welcome).toBeVisible();

        // The list is a tap away, and a saved chat opens from it.
        await page.getByRole("button", { name: "Chats", exact: true }).click();
        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        await expect(chats(page)).toBeHidden();
        await expect(welcome).toBeHidden();

        // Opened again, it starts on a new chat; the saved one is still in the list.
        await page.reload();
        await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
        await expect(welcome).toBeVisible();
        await page.getByRole("button", { name: "Chats", exact: true }).click();
        await expect(chats(page).getByRole("button", { name: /^Seeded chat 1/ })).toBeVisible();
        expect(realApp.problems).toEqual([]);
        await phone.close();
      },
    );
  });
});
