import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #1201: omp 18.8 writes a card into a chat's title, `<icon> <CODE>: <title>`. The session list, the chat header and
 * the delete confirmation show the title's own words, without the icon or the code. The stored title keeps the card,
 * which the list, the header and the rename box never show: a rename stores the name as typed, so the card goes with it.
 * Search still finds the chat by its code.
 */

realTest.use({ seedSessions: 12 });

/** A Nerd Font glyph (a private-use character, `fa-flask`) as the card's icon, the way omp writes it. */
const CARD_ICON = "\uF0C3";
/** The title omp stores: the card, then the person's own words. */
const STORED_TITLE = `${CARD_ICON} FLAKY: Fix flaky park tests`;
/** What the app shows for that chat. */
const WORDS = "Fix flaky park tests";

/** The sidebar row whose title is `title`. */
function rowFor(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(title) });
}

/** Opens a row's rename box from its menu. The box starts from the stored title, card included. */
async function openRename(page: Page, shown: string): Promise<Locator> {
  await rowFor(page, shown).hover();
  await page.getByRole("button", { name: `More actions for ${shown}` }).click();
  await page
    .getByRole("menu", { name: `Actions for ${shown}` })
    .getByRole("menuitem", { name: `Rename ${shown}` })
    .click();
  return page.getByRole("textbox", { name: `Rename ${shown}` });
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "#1201 real omp: a card title shows as its own words in the list, the header and the delete confirmation; the stored title keeps the card",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(rowFor(page, "Seeded chat 11")).toBeVisible({ timeout: 30_000 });

    // omp keeps the card in the chat's title: the name is saved as typed, icon and code included.
    const box = await openRename(page, "Seeded chat 11");
    await box.fill(STORED_TITLE);
    await box.press("Enter");

    const row = rowFor(page, WORDS);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).not.toContainText(CARD_ICON);
    await expect(row).not.toContainText("FLAKY");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1201-card-list-light.png"),
    });

    // The open chat's header shows the words too.
    await row.click();
    await expect(
      page.getByRole("main", { name: "Conversation" }).getByText(WORDS, { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1201-card-header-light.png"),
    });

    // Delete asks with the words, and Cancel keeps the chat.
    await page.getByRole("button", { name: `More actions for ${WORDS}` }).click();
    await page
      .getByRole("menu", { name: `Actions for ${WORDS}` })
      .getByRole("menuitem", { name: `Delete ${WORDS}` })
      .click();
    const confirm = page.getByRole("dialog", { name: "Delete chat" });
    await expect(confirm).toContainText(`Delete "${WORDS}"?`);
    await expect(confirm).not.toContainText("FLAKY");
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1201-delete-light.png"),
    });
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toHaveCount(0);

    // Search still finds the chat by the code the stored title keeps.
    const search = page.getByRole("textbox", { name: "Search sessions" });
    await search.fill("FLAKY");
    await expect(rowFor(page, WORDS)).toBeVisible();
    await search.fill("");

    // After a reload the list shows the same words, in dark too.
    await page.reload();
    await expect(rowFor(page, WORDS)).toBeVisible({ timeout: 60_000 });
    await expect(rowFor(page, WORDS)).not.toContainText(CARD_ICON);
    await setTheme(page, true);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1201-card-list-dark.png"),
    });
    await setTheme(page, false);

    // At 390 px the list still shows the words.
    await page.setViewportSize({ width: 390, height: 844 });
    const showSidebar = page.getByRole("button", { name: "Show sessions sidebar" });
    if (await showSidebar.isVisible()) await showSidebar.click();
    await expect(rowFor(page, WORDS)).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1201-card-list-narrow.png"),
    });

    // The rename box opens with the words, so the card's icon is not shown in it.
    // A name typed there is saved as typed: the card goes with a rename, and the list shows the name as typed.
    const reopened = await openRename(page, WORDS);
    await expect(reopened).toHaveValue(WORDS);
    await reopened.screenshot({
      animations: "disabled",
      path: join(screenshots, "fix-1201-rename-box-light.png"),
    });
    await reopened.fill("Plain park tests");
    await reopened.press("Enter");
    await expect(rowFor(page, "Plain park tests")).toBeVisible({ timeout: 30_000 });
    expect(realApp.problems).toEqual([]);
  },
);
