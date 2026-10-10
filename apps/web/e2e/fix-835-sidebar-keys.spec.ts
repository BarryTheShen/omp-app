import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * #835: the arrow keys move focus down the chat list, the row that has focus shows its focus ring,
 * and Enter opens that row. Real omp with twelve chats in the folder: "Seeded chat 12" is the first
 * row, so the third is "Seeded chat 10", the chat the report opened.
 */

realTest.use({ seedSessions: 12 });
realTest.setTimeout(240_000);

const NARROW = { width: 390, height: 844 } as const;

/** The chat row whose name starts with this title (the title first, then its time and branch). */
function chatRow(list: Locator, title: string): Locator {
  return list.getByRole("option", { name: new RegExp(`^${title}\\b`) });
}

/** The focus ring is a box shadow (`focus-visible:ring-2`); "none" means the row shows no ring. */
async function ringOf(row: Locator): Promise<string> {
  return row.evaluate((element) => getComputedStyle(element).boxShadow);
}

realTest(
  "the arrow keys move focus down the chat list with a ring, and Enter opens the chat that has focus",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });

    // The search box comes right before the list: one Tab puts focus on the first chat's row.
    await page.getByRole("textbox", { name: "Search sessions" }).focus();
    await page.keyboard.press("Tab");
    await expect(chatRow(list, "Seeded chat 12")).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const third = chatRow(list, "Seeded chat 10");
    await expect(third).toBeFocused();
    await expect.poll(() => ringOf(third)).not.toBe("none");

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "sidebar-keys-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "sidebar-keys-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.keyboard.press("Enter");
    await expect(
      page
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: "Seeded chat 10" }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(third).toHaveAttribute("aria-selected", "true");
    expect(realApp.problems).toEqual([]);
  },
);

realTest("at 390 px the focused chat row shows its ring too", async ({ realApp }) => {
  const page = await realApp.open();
  await page.setViewportSize(NARROW);
  // The narrow layout applies after the resize: wait for it, then open the chat list's drawer.
  await expect(page.locator('[data-shell-layout="narrow"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  const list = page.getByRole("listbox", { name: "Session list" });
  await expect(list.getByRole("option").first()).toBeVisible({ timeout: 60_000 });

  await page.getByRole("textbox", { name: "Search sessions" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const third = chatRow(list, "Seeded chat 10");
  await expect(third).toBeFocused();
  await expect.poll(() => ringOf(third)).not.toBe("none");

  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "sidebar-keys-narrow.png") });
  expect(realApp.problems).toEqual([]);
});
