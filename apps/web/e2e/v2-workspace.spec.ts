import type { Locator, Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's workspaces (#2791) on real omp: tabs on top, always shown, each made of windows; a window is blank, with
 * only New chat, until a chat fills it, and the split keys make blank windows. kitty's keys move, zoom and close windows;
 * a new chat never takes another's place; the list opens chats into windows; layouts are kept across a reload; a phone
 * shows one chat at a time.
 */
realTest.describe("new UI workspace", () => {
  realTest.setTimeout(240_000);
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const shown = (page: Page) => page.locator("[data-tab]:not([hidden])");
  const blanks = (page: Page) => shown(page).locator("[data-blank-window]");
  const blankNewChat = (page: Page) => blanks(page).getByRole("button", { name: "New chat" });
  const workspaces = (page: Page) =>
    page.getByRole("tablist", { name: "Workspaces" }).getByRole("tab");
  const opened = async (page: Page, count: number) => {
    await expect(boxes(page)).toHaveCount(count, { timeout: 60_000 });
    for (let index = 0; index < count; index += 1)
      await expect(boxes(page).nth(index)).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
  };

  realTest(
    "a split makes a blank window with the caret on its New chat; zoom, moving between windows and closing one with kitty's keys; the windows come back after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      // A workspace starts as one blank window: New chat in it, none in the list.
      await expect(blankNewChat(page)).toBeVisible();
      await expect(chats(page).getByRole("button", { name: "New chat" })).toHaveCount(0);
      await expect(chats(page).getByRole("button", { name: "New workspace" })).toBeVisible();
      await startNewChat(page);
      await opened(page, 1);
      await boxes(page).first().click();

      await page.keyboard.press("Control+Shift+O");
      await expect(blankNewChat(page)).toBeFocused();
      await expect(boxes(page)).toHaveCount(1);
      await page.keyboard.press("Enter");
      await opened(page, 2);
      await expect(boxes(page).nth(1)).toBeFocused();
      await page.keyboard.press("Control+Shift+E");
      await expect(blankNewChat(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await opened(page, 3);
      await expect(boxes(page).nth(2)).toBeFocused();

      await page.keyboard.press("Meta+Control+ArrowLeft");
      await expect(boxes(page).nth(0)).toBeFocused();
      await page.keyboard.type("only in the left window");

      await page.keyboard.press("Control+Shift+Enter");
      await expect(boxes(page).filter({ visible: true })).toHaveCount(1);
      await expect(boxes(page).filter({ visible: true })).toHaveValue("only in the left window");
      await page.keyboard.press("Control+Shift+Enter");
      await expect(boxes(page).filter({ visible: true })).toHaveCount(3);

      await page.keyboard.press("Meta+Control+BracketRight");
      await expect(boxes(page).nth(0)).not.toBeFocused();
      await page.keyboard.press("Meta+Control+ArrowLeft");
      await expect(boxes(page).nth(0)).toBeFocused();
      await page.keyboard.press("Control+Shift+W");
      await expect(boxes(page)).toHaveCount(2);
      await expect(blanks(page)).toHaveCount(0);

      // A blank window is kept too, and its × closes it.
      await page.keyboard.press("Control+Shift+O");
      await expect(blankNewChat(page)).toBeFocused();
      await page.reload();
      await opened(page, 2);
      await expect(blanks(page)).toHaveCount(1);
      await blanks(page).getByRole("button", { name: "Close the window" }).click();
      await expect(blanks(page)).toHaveCount(0);
      await expect(boxes(page)).toHaveCount(2);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "closing a workspace's last chat leaves its blank window, which has no ×",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await opened(page, 1);
      await boxes(page).first().click();
      await page.keyboard.press("Control+Shift+W");
      await expect(boxes(page)).toHaveCount(0);
      await expect(blankNewChat(page)).toBeVisible();
      await expect(workspaces(page)).toHaveCount(1);
      // A blank window that is the workspace's only one has no ×.
      await expect(blanks(page).getByRole("button", { name: "Close the window" })).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "window mode: Ctrl+Shift+Space, then the arrows go between windows, Shift+arrows resize, = shares the space, ] goes on; Esc or 3 s end it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await opened(page, 1);
      await boxes(page).first().click();
      await page.keyboard.press("Control+Shift+O");
      await expect(blankNewChat(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await opened(page, 2);
      await expect(boxes(page).nth(1)).toBeFocused();
      const mode = page.getByRole("status").filter({ hasText: "Window mode" });
      const width = async (index: number) =>
        Math.round((await boxes(page).nth(index).boundingBox())?.width ?? 0);

      await page.keyboard.press("Control+Shift+Space");
      await expect(mode).toBeVisible();
      await expect(boxes(page).nth(1)).toHaveValue("");
      await page.keyboard.press("ArrowLeft");
      await expect(boxes(page).nth(0)).toBeFocused();

      const before = await width(0);
      await page.keyboard.press("Shift+ArrowRight");
      await expect.poll(() => width(0)).toBeGreaterThan(before + 20);
      await page.keyboard.press("=");
      await expect.poll(async () => Math.abs((await width(0)) - (await width(1)))).toBeLessThan(4);
      await page.keyboard.press("]");
      await expect(boxes(page).nth(1)).toBeFocused();
      await expect(boxes(page).nth(1)).toHaveValue("");

      await page.keyboard.press("Escape");
      await expect(mode).toHaveCount(0);
      await page.keyboard.type("x");
      await expect(boxes(page).nth(1)).toHaveValue("x");

      await page.keyboard.press("Control+Shift+Space");
      await expect(mode).toBeVisible();
      await expect(mode).toHaveCount(0, { timeout: 5_000 });

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "workspaces: always on top; a new one is a blank window, named after its first chat; rename, drag, next, close and + ; they come back after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(workspaces(page)).toHaveCount(1);
      await expect(workspaces(page).first()).toHaveText("New workspace");
      await startNewChat(page);
      await opened(page, 1);
      await boxes(page).first().click();

      await page.keyboard.press("Control+Shift+T");
      await expect(workspaces(page)).toHaveCount(2);
      await expect(workspaces(page).nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(boxes(page).filter({ visible: true })).toHaveCount(0);
      await expect(blankNewChat(page)).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(boxes(page).filter({ visible: true })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 120_000 },
      );
      await boxes(page).filter({ visible: true }).fill("count_reply parser");
      await boxes(page).filter({ visible: true }).press("Enter");
      await expect(workspaces(page).nth(1)).toHaveText("count_reply parser", { timeout: 60_000 });

      await page.keyboard.press("Control+Shift+Alt+T");
      const name = page.getByRole("textbox", { name: "Workspace name" });
      await expect(name).toBeFocused();
      await name.fill("Parser work");
      await name.press("Enter");
      await expect(workspaces(page).nth(1)).toHaveText("Parser work");
      // An empty name goes back to the first chat's title.
      await workspaces(page).nth(1).dblclick();
      await name.fill("");
      await name.press("Enter");
      await expect(workspaces(page).nth(1)).toHaveText("count_reply parser");
      await workspaces(page).nth(1).dblclick();
      await name.fill("Parser work");
      await name.press("Enter");

      // Dragged onto the first, it takes the first place.
      await dragTo(page, workspaces(page).nth(1), await middleOf(workspaces(page).nth(0)));
      await expect(workspaces(page).nth(0)).toHaveText("Parser work");
      await boxes(page).filter({ visible: true }).click();
      await page.keyboard.press("Control+Tab");
      await expect(workspaces(page).nth(1)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Control+Shift+Q");
      await expect(workspaces(page)).toHaveCount(1);

      await page.getByRole("button", { name: "New workspace" }).last().click();
      await expect(workspaces(page)).toHaveCount(2);
      await expect(blankNewChat(page)).toBeVisible();
      await page.reload();
      await expect(workspaces(page)).toHaveCount(2, { timeout: 60_000 });
      await expect(workspaces(page).nth(0)).toHaveText("Parser work");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("with three saved chats", () => {
    realTest.use({ seedSessions: 3 });
    const row = (page: Page, n: number) =>
      chats(page).getByRole("button", { name: new RegExp(`^Seeded chat ${n}\\b`) });

    realTest(
      "a click fills a blank window or shows the chat in the focused one, Alt+click beside it, an open chat gets the focus, and a new chat opens beside",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await row(page, 1).click();
        await opened(page, 1);
        await expect(blanks(page)).toHaveCount(0);
        await expect(row(page, 1)).toHaveAttribute("aria-current", "true");
        await expect(row(page, 1)).toHaveAccessibleName("Seeded chat 1, open in a window");

        await row(page, 2).click({ modifiers: ["Alt"] });
        await opened(page, 2);
        await expect(row(page, 2)).toHaveAttribute("aria-current", "true");
        await expect(boxes(page).nth(1)).toBeFocused();

        await row(page, 1).click();
        await expect(boxes(page)).toHaveCount(2);
        await expect(boxes(page).nth(0)).toBeFocused();

        // A chat from the list shows in the focused window, in place of the chat there, which keeps running.
        await row(page, 3).click();
        await expect(boxes(page)).toHaveCount(2);
        await expect(row(page, 3)).toHaveAccessibleName("Seeded chat 3, open in a window");
        await expect(row(page, 1)).toHaveAccessibleName("Seeded chat 1");

        // A new chat never takes another's place: from the palette it opens in a window beside.
        await page.keyboard.press("Control+K");
        await page.getByRole("option", { name: "New chat", exact: true }).click();
        await opened(page, 3);
        await expect(row(page, 3)).toHaveAccessibleName("Seeded chat 3, open in a window");
        await expect(row(page, 2)).toHaveAccessibleName("Seeded chat 2, open in a window");

        // A blank window takes the chat clicked next.
        await page.keyboard.press("Control+Shift+O");
        await expect(blankNewChat(page)).toBeFocused();
        await row(page, 1).click();
        await opened(page, 4);
        await expect(blanks(page)).toHaveCount(0);
        await expect(row(page, 1)).toHaveAccessibleName("Seeded chat 1, open in a window");

        expect(realApp.problems).toEqual([]);
      },
    );

    realTest("a chat dragged from the list fills a blank window", async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await row(page, 1).click();
      await opened(page, 1);
      await boxes(page).first().click();
      await page.keyboard.press("Control+Shift+O");
      await expect(blanks(page)).toHaveCount(1);
      // Near the blank window's edge too: the whole of it takes the chat.
      const blank = await blanks(page).boundingBox();
      if (blank === null) throw new Error("no blank window");
      await row(page, 2).hover();
      await page.mouse.down();
      await page.mouse.move(blank.x + blank.width - 40, blank.y + blank.height / 2, { steps: 15 });
      await expect(shown(page).locator("[data-drop-label]")).toHaveText("Open here");
      await page.mouse.up();
      await opened(page, 2);
      await expect(blanks(page)).toHaveCount(0);
      await expect(row(page, 2)).toHaveAccessibleName("Seeded chat 2, open in a window");
      expect(realApp.problems).toEqual([]);
    });

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
      // Two windows, but the phone shows only the one in front (the other is hidden, out of the page's roles).
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
        await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", {
          timeout: 120_000,
        });
        await expect(welcome).toBeVisible();

        // The list is a tap away, and a saved chat opens from it.
        await page.getByRole("button", { name: "Chats", exact: true }).click();
        await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
        await expect(chats(page)).toBeHidden();
        await expect(welcome).toBeHidden();

        // Opened again, it starts on a new chat; the saved one is still in the list.
        await page.reload();
        await expect(boxes(page)).toHaveAttribute("placeholder", "Message omp", {
          timeout: 120_000,
        });
        await expect(welcome).toBeVisible();
        await page.getByRole("button", { name: "Chats", exact: true }).click();
        await expect(chats(page).getByRole("button", { name: /^Seeded chat 1/ })).toBeVisible();
        expect(realApp.problems).toEqual([]);
        await phone.close();
      },
    );
  });
});

/** The middle of an element, for a drag to land on it. */
async function middleOf(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags with the pointer from an element to a point, as a person would. */
async function dragTo(page: Page, source: Locator, point: { x: number; y: number }) {
  await source.hover();
  await page.mouse.down();
  await page.mouse.move(point.x, point.y, { steps: 15 });
  await page.mouse.up();
}
