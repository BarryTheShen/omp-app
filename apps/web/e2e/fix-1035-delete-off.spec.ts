import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

// Two older chats, written the way omp writes them.
realTest.use({ seedSessions: 2 });

const REASON = "Deleting a chat isn't available in the app yet.";

/** The chat's More actions menu, and its Delete item. */
function deleteItem(page: Page): Locator {
  return page
    .getByRole("menu", { name: "Actions for Seeded chat 2" })
    .getByRole("menuitem", { name: "Delete Seeded chat 2" });
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
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
  "#1035: the chat's Delete item is shown disabled with the plain reason, in light, dark and at 390 px",
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
    await expect(deleteItem(page)).toBeDisabled();
    await expect(deleteItem(page)).toHaveAttribute("title", REASON);
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-1035-delete-off-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1035-delete-off-dark.png") });

    // At 390 px the sessions sidebar is collapsed: open it again, then the chat's menu.
    await setTheme(page, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /^Show sessions sidebar$/i }).click();
    await page.getByRole("button", { name: "More actions for Seeded chat 2" }).click();
    await expect(deleteItem(page)).toBeDisabled();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1035-delete-off-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);
