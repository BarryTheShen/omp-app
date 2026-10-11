import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

// Three older chats, written the way omp writes them. The list runs newest first: 3, 2, 1.
realTest.use({ seedSessions: 3 });

/** The chat's row in the Session list: an option whose name starts with its title. */
function chatRow(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(`^${title}`) });
}

/** The chat's More actions menu. */
function chatMenu(page: Page, title: string): Locator {
  return page.getByRole("menu", { name: `Actions for ${title}` });
}

/** Lets finite transitions settle before a screenshot. Bounded, so a transition that never ends cannot hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await settle(page);
}

realTest(
  "#973: Escape on a More actions button closes its menu and keeps the focus on that button (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const more = page.getByRole("button", { name: "More actions for Seeded chat 2" });
    await expect(more).toBeVisible({ timeout: 60_000 });

    await more.click();
    await expect(chatMenu(page, "Seeded chat 2")).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-973-escape-light.png") });

    await page.keyboard.press("Escape");
    await expect(chatMenu(page, "Seeded chat 2")).toHaveCount(0);
    await expect(more).toBeFocused();
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-973-escape-dark.png") });

    // At 390 px the sessions sidebar is collapsed: open it again, then the chat's menu.
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /^Show sessions sidebar$/i }).click();
    const narrowMore = page.getByRole("button", { name: "More actions for Seeded chat 2" });
    await narrowMore.click();
    await expect(chatMenu(page, "Seeded chat 2")).toBeVisible();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-973-escape-narrow.png") });

    await page.keyboard.press("Escape");
    await expect(chatMenu(page, "Seeded chat 2")).toHaveCount(0);
    await expect(narrowMore).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "#973: Tab back into the list lands on the open chat's row",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await expect(chatRow(page, "Seeded chat 2")).toBeVisible({ timeout: 60_000 });

    // Open chat 2. The sidebar refreshes when a chat opens and that clears its focused row, so focus
    // moves only once the composer is up (it exists only for an open chat) and the list has settled.
    await chatRow(page, "Seeded chat 2").click();
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
      timeout: 60_000,
    });
    await settle(page);
    // Then move focus to the search box above the list, and Tab back into the list.
    await page.getByPlaceholder("Search sessions").click();
    await page.keyboard.press("Tab");
    await expect(chatRow(page, "Seeded chat 2")).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);
