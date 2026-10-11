import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

// Three older chats, written the way omp writes them. The list runs newest first: 3, 2, 1.
realTest.use({ seedSessions: 3 });

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

/** Keyboard only: Tab from the page until a chat row has focus, which is how a keyboard user gets into the list. */
async function tabIntoList(page: Page): Promise<void> {
  for (let presses = 0; presses < 60; presses++) {
    if (await page.evaluate(() => document.activeElement?.getAttribute("role") === "option"))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Tab never reached a chat row in the Session list.");
}

/** Keyboard only: from the list, Home goes to the newest chat, ArrowDown to "Seeded chat 2", Tab to its More actions button. */
async function focusMoreOfChat2(page: Page): Promise<Locator> {
  await tabIntoList(page);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  const more = page.getByRole("button", { name: "More actions for Seeded chat 2" });
  await page.keyboard.press("Tab");
  await expect(more).toBeFocused();
  return more;
}

/** Enter on the More actions button, Tab to Rename, Escape: the path the issue reports. */
async function menuPathAndEscape(page: Page, more: Locator, title: string): Promise<void> {
  await expect(more).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(chatMenu(page, title)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    chatMenu(page, title).getByRole("menuitem", { name: `Rename ${title}` }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(chatMenu(page, title)).toHaveCount(0);
  await expect(more).toBeFocused();
}

realTest(
  "#1059: with the keyboard only, Escape inside a chat's menu puts the focus back on its More actions button (light, dark, 390 px)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await expect(page.getByRole("listbox", { name: "Session list" })).toBeVisible({
      timeout: 60_000,
    });

    const more = await focusMoreOfChat2(page);
    await menuPathAndEscape(page, more, "Seeded chat 2");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1059-escape-light.png") });

    await setTheme(page, true);
    await menuPathAndEscape(page, more, "Seeded chat 2");
    await page.screenshot({ path: join(screenshots, "fix-1059-escape-dark.png") });

    // At 390 px the sessions sidebar is collapsed: open it, then the same keys reach the chat's More actions button.
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /^Show sessions sidebar$/i }).click();
    const narrowMore = await focusMoreOfChat2(page);
    await menuPathAndEscape(page, narrowMore, "Seeded chat 2");
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1059-escape-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
