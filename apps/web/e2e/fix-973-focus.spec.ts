import type { Locator, Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

// Three older chats, written the way omp writes them. The list runs newest first: 3, 2, 1.
realTest.use({ seedSessions: 3 });

/** The chat's row in the Session list: an option whose name starts with its title. */
function chatRow(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(`^${title}`) });
}

/** Presses Tab, one key at a time, until the target has focus: the keyboard path to a control, not a click. */
async function tabTo(page: Page, target: Locator, maxPresses = 10): Promise<void> {
  for (let press = 0; press < maxPresses; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

realTest(
  "#973: a chat deleted by the keyboard hands focus to the next row, and the arrow keys go on from there",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await expect(chatRow(page, "Seeded chat 3")).toBeVisible({ timeout: 60_000 });

    // Reach "Seeded chat 2" with the arrow keys from the first row.
    await chatRow(page, "Seeded chat 3").focus();
    await page.keyboard.press("ArrowDown");
    await expect(chatRow(page, "Seeded chat 2")).toBeFocused();

    // Delete it from its menu with the keyboard: Tab to More actions, Enter, Tab to Delete, Enter.
    await tabTo(page, page.getByRole("button", { name: "More actions for Seeded chat 2" }));
    await page.keyboard.press("Enter");
    const deleteItem = page
      .getByRole("menu", { name: "Actions for Seeded chat 2" })
      .getByRole("menuitem", { name: "Delete Seeded chat 2" });
    await tabTo(page, deleteItem);
    await page.keyboard.press("Enter");

    // The confirmation opens with Cancel focused; Tab reaches Delete, and Enter deletes.
    const dialog = page.getByRole("dialog", { name: "Delete chat" });
    await expect(dialog).toBeVisible();
    await tabTo(page, dialog.getByRole("button", { name: "Delete", exact: true }));
    await page.keyboard.press("Enter");

    // The row is gone, and focus is on the next row (Seeded chat 1) with the tab stop on it, not on the page body.
    await expect(chatRow(page, "Seeded chat 2")).toHaveCount(0, { timeout: 30_000 });
    await expect(chatRow(page, "Seeded chat 1")).toBeFocused();
    await expect(chatRow(page, "Seeded chat 1")).toHaveAttribute("tabindex", "0");

    // The arrow keys continue from there: up to the row above, and back down.
    await page.keyboard.press("ArrowUp");
    await expect(chatRow(page, "Seeded chat 3")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(chatRow(page, "Seeded chat 1")).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);
