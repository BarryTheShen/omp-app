import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * D1, the chats that run in other folders (`apps/ui/src/sidebar`, the server's `A0.runningChats`), on real omp: a chat
 * that runs on in one folder is listed at the top of another folder's list with its folder's name and its state, and
 * opens from there in the focused window, by a click or a drop. A folder's own running chats are in its list already,
 * so they are not listed twice. Stop running ends one: a turn that runs first, after asking; another tab that has it
 * open refuses it.
 */
realTest.describe("new UI chats running in other folders", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 1 });
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const elsewhere = (page: Page) =>
    chats(page).getByRole("region", { name: "Running in other folders" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const blank = (page: Page) => page.locator("[data-tab]:not([data-hidden]) [data-blank-window]");

  /** Opens a folder by its typed path through the folder menu's "Open a folder…". */
  async function openFolder(page: Page, typed: string): Promise<void> {
    await chats(page)
      .getByRole("button", { name: /^Folder: / })
      .click();
    await page.getByRole("menuitem", { name: "Open a folder…" }).click();
    const dialog = page.getByRole("dialog", { name: "Open a folder" });
    await dialog.getByRole("textbox", { name: "Folder path" }).fill(typed);
    await dialog.getByRole("button", { name: "Open" }).click();
    await expect(dialog).toBeHidden();
  }

  /** Chooses Stop running in the menu of a chat's row in the running list. */
  async function chooseStop(page: Page, title: string): Promise<void> {
    const item = elsewhere(page).getByRole("listitem").filter({ hasText: title });
    await item.hover();
    await item.getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Stop running" }).click();
  }

  realTest(
    "a chat that runs on in one folder is listed in another with its folder and state, and a click or a drop opens it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const home = basename(realApp.folder);
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await box(page).fill("stream_steady");
      await box(page).press("Enter");
      await expect(
        chats(page).getByRole("button", { name: /^Seeded chat 1, running/ }),
      ).toBeVisible({ timeout: 60_000 });
      // This folder's running chat is in its own list: no second row for it.
      await expect(elsewhere(page)).toHaveCount(0);

      // Its window closes and the chat runs on; another folder lists it, with this folder's name.
      await box(page).press("Control+Shift+W");
      await expect(blank(page)).toBeVisible();
      await openFolder(page, realApp.otherFolder);
      const row = elsewhere(page).getByRole("button", { name: /^Seeded chat 1/ });
      await expect(row).toHaveAccessibleName(`Seeded chat 1, in ${home}, running`, {
        timeout: 60_000,
      });
      await expect(row).toContainText(home);

      // A click opens it in the focused window, the blank one; Esc ends its turn, and its mark goes.
      await row.click();
      await expect(blank(page)).toHaveCount(0);
      await expect(page.getByRole("main").getByText("stream_steady", { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      await expect(row).toHaveAccessibleName(
        `Seeded chat 1, in ${home}, running, open in a window`,
      );
      await box(page).press("Escape");
      await expect(row).toHaveAccessibleName(`Seeded chat 1, in ${home}, open in a window`, {
        timeout: 60_000,
      });

      // Closed again, it is dropped onto the blank window, and opens there.
      await box(page).press("Control+Shift+W");
      await expect(blank(page)).toBeVisible();
      await expect(row).toHaveAccessibleName(`Seeded chat 1, in ${home}`);
      const area = await blank(page).boundingBox();
      if (area === null) throw new Error("no blank window");
      await row.hover();
      await page.mouse.down();
      await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2, { steps: 15 });
      await page.mouse.up();
      await expect(blank(page)).toHaveCount(0);
      await expect(row).toHaveAccessibleName(`Seeded chat 1, in ${home}, open in a window`);

      // An idle chat stops at once, without asking: its window here goes blank, and it leaves the list.
      await chooseStop(page, "Seeded chat 1");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect(blank(page)).toBeVisible();

      // Back in its own folder, it is in that folder's list, not listed twice.
      await openFolder(page, realApp.folder);
      await expect(chats(page).getByRole("button", { name: /^Seeded chat 1/ })).toBeVisible();
      await expect(elsewhere(page)).toHaveCount(0);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Stop running asks before it ends a turn; another tab that has the chat open refuses it; once stopped, opening the chat starts it again",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const home = basename(realApp.folder);
      await chats(page).getByRole("button", { name: "Seeded chat 1" }).click();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      // A reply held until the spec lets it go: the turn runs as long as the test needs.
      await box(page).fill("stream_held");
      await box(page).press("Enter");
      await expect(
        chats(page).getByRole("button", { name: /^Seeded chat 1, running/ }),
      ).toBeVisible({ timeout: 60_000 });
      await box(page).press("Control+Shift+W");
      await openFolder(page, realApp.otherFolder);
      const row = elsewhere(page).getByRole("button", { name: /^Seeded chat 1/ });
      await expect(row).toHaveAccessibleName(`Seeded chat 1, in ${home}, running`, {
        timeout: 60_000,
      });

      // Another tab shows the chat: the stop asks, then is refused and says why; the turn goes on.
      const other = await realApp.open({ path: "/" });
      await chats(other)
        .getByRole("button", { name: /^Seeded chat 1/ })
        .click();
      await expect(box(other)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await chooseStop(page, "Seeded chat 1");
      const ask = page.getByRole("alertdialog", { name: "Stop this chat?" });
      await expect(ask).toContainText("“Seeded chat 1” is in the middle of a turn");
      await ask.getByRole("button", { name: "Stop running" }).click();
      await expect(chats(page).getByRole("alert")).toHaveText(
        "Could not stop it: Another tab or window has this chat open. Close it there, then stop it again.",
        { timeout: 30_000 },
      );
      await expect(row).toHaveAccessibleName(`Seeded chat 1, in ${home}, running`);

      // Closed there, the stop ends the turn and then the chat: it leaves the running list.
      await box(other).press("Control+Shift+W");
      await chooseStop(page, "Seeded chat 1");
      await ask.getByRole("button", { name: "Stop running" }).click();
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect(chats(page).getByRole("alert")).toHaveCount(0);

      // In its own folder it is listed with no mark, and opening it starts it again.
      await openFolder(page, realApp.folder);
      const listed = chats(page).getByRole("button", { name: /^Seeded chat 1/ });
      await expect(listed).toHaveAccessibleName("Seeded chat 1", { timeout: 30_000 });
      await listed.click();
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
