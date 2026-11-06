import type { Locator, Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's workspaces (#2791) on real omp: tabs on top, always shown, each made of windows; a window is blank, with
 * only New chat, until a chat fills it, and the split keys make blank windows. kitty's keys move, zoom and close windows;
 * a browser's tab keys work the workspaces, and the list opens a chat as a browser opens a link (#2831); layouts are kept
 * across a reload; a phone shows one chat at a time.
 */
realTest.describe("new UI workspace", () => {
  realTest.setTimeout(240_000);
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const shown = (page: Page) => page.locator("[data-tab]:not([data-hidden])");
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

      await page.keyboard.press("Control+t");
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

  realTest(
    "in an app window Ctrl+1 to Ctrl+8 go to that workspace and Ctrl+9 to the last; a browser tab leaves them to the browser, and its keys sheet marks the keys the browser keeps (#2831)",
    async ({ realApp, browser }) => {
      // A Home Screen app's window, as iOS reports it: the page gets every key there.
      const app = await browser.newContext();
      await app.addInitScript(() =>
        Object.defineProperty(navigator, "standalone", { value: true }),
      );
      const page = await realApp.open({ path: "/", context: app });
      await expect(blankNewChat(page)).toBeVisible({ timeout: 60_000 });
      await page.keyboard.press("Control+t");
      await page.keyboard.press("Control+t");
      await expect(workspaces(page)).toHaveCount(3);
      await page.keyboard.press("Control+1");
      await expect(workspaces(page).nth(0)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Control+9");
      await expect(workspaces(page).nth(2)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Control+2");
      await expect(workspaces(page).nth(1)).toHaveAttribute("aria-selected", "true");
      // Its keys sheet lists them and marks no key as the browser's.
      await page.keyboard.press("Control+Slash");
      const sheet = page.getByRole("dialog", { name: "Keys" });
      await expect(sheet.getByText("Go to workspace 1 to 8; 9: the last one")).toBeVisible();
      await expect(sheet.locator("[data-browser-kept]")).toHaveCount(0);
      await expect(sheet.locator("[data-browser-keeps]")).toHaveCount(0);
      await app.close();

      // In a browser tab Ctrl+1 is the browser's, and the sheet marks Ctrl+T as the browser's, not Ctrl+O.
      const tab = await realApp.open({ path: "/" });
      await expect(blankNewChat(tab)).toBeVisible({ timeout: 60_000 });
      await tab.keyboard.press("Control+t");
      await expect(workspaces(tab)).toHaveCount(2);
      await tab.keyboard.press("Control+1");
      await tab.waitForTimeout(500);
      await expect(workspaces(tab).nth(1)).toHaveAttribute("aria-selected", "true");
      await tab.keyboard.press("Control+Slash");
      const kept = tab.getByRole("dialog", { name: "Keys" });
      await expect(kept.locator("[data-browser-keeps]")).toBeVisible();
      await expect(kept.getByText("Go to workspace 1 to 8; 9: the last one")).toHaveCount(0);
      const keys = kept.getByRole("region", { name: "Workspaces" }).locator("kbd");
      await expect(keys.filter({ hasText: /^Ctrl\+T\*/ })).toHaveAttribute("data-browser-kept", "");
      await expect(keys.filter({ hasText: /^Ctrl\+O$/ })).not.toHaveAttribute(
        "data-browser-kept",
        "",
      );
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest.describe("with three saved chats", () => {
    realTest.use({ seedSessions: 3 });
    const row = (page: Page, n: number) =>
      chats(page).getByRole("button", { name: new RegExp(`^Seeded chat ${n}\\b`) });

    realTest(
      "a click fills a blank window, else opens the chat in a workspace of its own; Alt+click beside; an open chat gets the focus; a new chat opens in a workspace of its own, and closing it goes back (#2831)",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await row(page, 1).click();
        await opened(page, 1);
        await expect(blanks(page)).toHaveCount(0);
        await expect(workspaces(page)).toHaveCount(1);
        await expect(row(page, 1)).toHaveAttribute("aria-current", "true");
        await expect(row(page, 1)).toHaveAccessibleName("Seeded chat 1, open in a window");

        // Alt+click: in a window beside the focused one, in this workspace.
        await row(page, 2).click({ modifiers: ["Alt"] });
        await opened(page, 2);
        await expect(workspaces(page)).toHaveCount(1);
        await expect(row(page, 2)).toHaveAttribute("aria-current", "true");
        await expect(boxes(page).nth(1)).toBeFocused();

        // An open chat: its window gets the focus.
        await row(page, 1).click();
        await expect(boxes(page)).toHaveCount(2);
        await expect(boxes(page).nth(0)).toBeFocused();

        // Another chat opens in a workspace of its own, right after this one and in front; the chats here stay open.
        await row(page, 3).click();
        await expect(workspaces(page)).toHaveCount(2);
        await expect(workspaces(page).nth(1)).toHaveAttribute("aria-selected", "true");
        await opened(page, 1);
        await expect(row(page, 3)).toHaveAttribute("aria-current", "true");
        await expect(row(page, 1)).toHaveAccessibleName("Seeded chat 1, open in a window");
        await expect(row(page, 2)).toHaveAccessibleName("Seeded chat 2, open in a window");

        // From the first workspace, a new chat (Ctrl+O) opens in a workspace of its own right after it; closing that
        // one goes back to the first, not on to its neighbour.
        await workspaces(page).nth(0).click();
        await expect(workspaces(page).nth(0)).toHaveAttribute("aria-selected", "true");
        await page.keyboard.press("Control+o");
        await expect(workspaces(page)).toHaveCount(3);
        await expect(workspaces(page).nth(1)).toHaveAttribute("aria-selected", "true");
        await opened(page, 1);
        await expect(boxes(page)).toBeFocused();
        await page.keyboard.press("Control+w");
        await expect(workspaces(page)).toHaveCount(2);
        await expect(workspaces(page).nth(0)).toHaveAttribute("aria-selected", "true");
        await expect(boxes(page)).toHaveCount(2);

        // A blank window you're in takes the new chat.
        await page.keyboard.press("Control+Shift+O");
        await expect(blankNewChat(page)).toBeFocused();
        await page.keyboard.press("Control+o");
        await opened(page, 3);
        await expect(blanks(page)).toHaveCount(0);
        await expect(workspaces(page)).toHaveCount(2);

        expect(realApp.problems).toEqual([]);
      },
    );

    realTest(
      "Ctrl+click and a middle click open chats behind, in the order clicked; closing a workspace's only window closes it, and Ctrl+Shift+T brings it back, also after a reload (#2831)",
      async ({ realApp }) => {
        const page = await realApp.open({ path: "/" });
        await row(page, 1).click();
        await opened(page, 1);
        await row(page, 2).click({ modifiers: ["Control"] });
        await row(page, 3).click({ button: "middle" });
        await expect(workspaces(page)).toHaveCount(3);
        // This workspace stays in front, as it was.
        await expect(workspaces(page).nth(0)).toHaveAttribute("aria-selected", "true");
        await expect(boxes(page)).toHaveCount(1);
        await expect(row(page, 1)).toHaveAttribute("aria-current", "true");
        await expect(workspaces(page).nth(1)).toHaveText("Seeded chat 2", { timeout: 60_000 });
        await expect(workspaces(page).nth(2)).toHaveText("Seeded chat 3", { timeout: 60_000 });
        await expect(row(page, 3)).toHaveAccessibleName("Seeded chat 3, open in a window");

        // The last workspace's only window closes, and the workspace with it.
        await workspaces(page).nth(2).click();
        await opened(page, 1);
        await boxes(page).click();
        await page.keyboard.press("Control+Shift+W");
        await expect(workspaces(page)).toHaveCount(2);
        await expect(workspaces(page).nth(1)).toHaveAttribute("aria-selected", "true");
        await expect(row(page, 3)).toHaveAccessibleName("Seeded chat 3");

        // Ctrl+Shift+T brings it back at its place, with its chat.
        await page.keyboard.press("Control+Shift+T");
        await expect(workspaces(page)).toHaveCount(3);
        await expect(workspaces(page).nth(2)).toHaveAttribute("aria-selected", "true");
        await expect(workspaces(page).nth(2)).toHaveText("Seeded chat 3");
        await opened(page, 1);
        await expect(row(page, 3)).toHaveAttribute("aria-current", "true");

        // The closed workspaces are kept with the others: closed again, it still comes back after a reload.
        await page.keyboard.press("Control+w");
        await expect(workspaces(page)).toHaveCount(2);
        await page.reload();
        await expect(workspaces(page)).toHaveCount(2, { timeout: 60_000 });
        await opened(page, 1);
        await page.keyboard.press("Control+Shift+T");
        await expect(workspaces(page)).toHaveCount(3);
        await expect(workspaces(page).nth(2)).toHaveText("Seeded chat 3");

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
      "a phone opens on a new chat with the list a tap away, and on a new chat again when opened again over an hour later",
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

        // Opened again over an hour after it was last up, it starts on a new chat (#2819); the saved one is still in
        // the list.
        await phone.addInitScript(() =>
          localStorage.setItem("omp-app:last-up", String(Date.now() - 2 * 60 * 60 * 1000)),
        );
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
