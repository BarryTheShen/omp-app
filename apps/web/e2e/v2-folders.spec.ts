import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The new UI's folder (`apps/ui/src/folders`) on real omp: the menu at the top of the sidebar switches the folder whose
 * chats are listed and where New chat starts one, opens any folder by its path, and the choice stays across a reload;
 * a launch link's folder wins over the one chosen before.
 */
realTest.describe("new UI folder switch", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 1 });
  const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
  const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const folderButton = (page: Page) => chats(page).getByRole("button", { name: /^Folder: / });
  const seeded = (page: Page) => chats(page).getByRole("button", { name: /^Seeded chat 1/ });

  /** Opens a folder by its typed path through the menu's "Open a folder…". */
  async function openFolder(page: Page, typed: string): Promise<void> {
    await folderButton(page).click();
    await page.getByRole("menuitem", { name: "Open a folder…" }).click();
    const dialog = page.getByRole("dialog", { name: "Open a folder" });
    await dialog.getByRole("textbox", { name: "Folder path" }).fill(typed);
    await dialog.getByRole("button", { name: "Open" }).click();
  }

  realTest(
    "the menu switches the list and New chat to another folder, a reload keeps it, and the menu goes back",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const home = basename(realApp.folder);
      const other = basename(realApp.otherFolder);
      await expect(folderButton(page)).toHaveText(home);
      await expect(folderButton(page)).toHaveAccessibleName(`Folder: ${realApp.folder}`);
      await expect(seeded(page)).toBeVisible({ timeout: 60_000 });

      await openFolder(page, realApp.otherFolder);
      await expect(page.getByRole("dialog", { name: "Open a folder" })).toBeHidden();
      await expect(folderButton(page)).toHaveText(other);
      await expect(seeded(page)).toHaveCount(0);

      // New chat starts in the folder shown, and its first reply puts it in that folder's list.
      await startNewChat(page);
      await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      // The new chat's first screen names where omp will work.
      await expect(page.getByRole("main").getByText(new RegExp(`/${other}$`))).toBeVisible();
      await box(page).fill("in the other folder");
      await box(page).press("Enter");
      const made = chats(page).getByRole("button", { name: /^in the other folder/ });
      await expect(made).toBeVisible({ timeout: 60_000 });

      await page.reload();
      await expect(folderButton(page)).toHaveText(other, { timeout: 30_000 });
      await expect(made).toBeVisible({ timeout: 60_000 });
      await expect(seeded(page)).toHaveCount(0);

      // Both folders now have chats, so the menu lists both, the one shown first and checked.
      await folderButton(page).click();
      const listed = page.getByRole("menu").getByRole("menuitem");
      await expect(listed.first()).toContainText(other);
      await listed.filter({ hasText: realApp.folder }).click();
      await expect(folderButton(page)).toHaveText(home);
      await expect(seeded(page)).toBeVisible({ timeout: 60_000 });
      // Its own list has none of the other folder's chats; one that still runs is listed above, under its folder (D1).
      await expect(
        chats(page)
          .getByRole("region", { name: "Chats" })
          .getByRole("button", { name: /^in the other folder/ }),
      ).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a path that is not a folder is refused with a reason, and the folder stays",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const home = basename(realApp.folder);
      await expect(folderButton(page)).toHaveText(home);
      const dialog = page.getByRole("dialog", { name: "Open a folder" });

      await openFolder(page, "code/app");
      await expect(dialog.getByRole("alert")).toHaveText(
        "Type the full path to the folder, for example /home/you/project.",
      );
      await dialog
        .getByRole("textbox", { name: "Folder path" })
        .fill(`${realApp.otherFolder}/missing`);
      await dialog.getByRole("button", { name: "Open" }).click();
      await expect(dialog.getByRole("alert")).toHaveText(
        "That folder doesn't exist. Check the path.",
      );
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(folderButton(page)).toHaveText(home);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("a link's folder opens it, ahead of the folder chosen before", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await expect(folderButton(page)).toHaveText(basename(realApp.folder));
    // The launch folder is chosen once through the menu, so the browser remembers it.
    await folderButton(page).click();
    await page.getByRole("menu").getByRole("menuitem").filter({ hasText: realApp.folder }).click();

    // The same tab keeps its token, so the address only needs the folder.
    const linked = new URL(page.url());
    linked.hash = `folder=${encodeURIComponent(realApp.otherFolder)}`;
    await page.goto(linked.toString());
    await page.reload();
    await expect(folderButton(page)).toHaveText(basename(realApp.otherFolder), { timeout: 30_000 });
    // The folder left the address, so a reload keeps the folder chosen since.
    expect(new URL(page.url()).hash).toBe("");

    expect(realApp.problems).toEqual([]);
  });

  realTest(
    "the Folders tour points at the folder and waits for its menu to open and close",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await page.keyboard.press("Control+k");
      const search = page
        .getByRole("dialog", { name: "Palette", exact: true })
        .getByRole("combobox", { name: "Search the palette" });
      await search.fill("Tour: Folders");
      await search.press("Enter");
      const popover = page.locator(".driver-popover");
      const title = popover.locator(".driver-popover-title");

      await expect(title).toHaveText("Your folder");
      await popover.getByRole("button", { name: "Next" }).click();
      await expect(title).toHaveText("Switch folders");
      await folderButton(page).click();
      await expect(title).toHaveText("Pick one");
      await page.keyboard.press("Escape");
      await expect(popover).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );
});
