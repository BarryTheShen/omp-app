import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Feedback #661: 'older sessions cannot be reached'. The sidebar listed only the newest 50 chats
 * and had no way to ask for more. This is the real app with 130 old chats in the folder (the owner's
 * folder has 148).
 */
realTest.use({ seedSessions: 130 });

realTest(
  "the sidebar shows 50 chats, 'Show older chats' reaches the oldest of 130, and a refresh keeps them",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 720 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option")).toHaveCount(50, { timeout: 60_000 });
    await expect(list.getByRole("option").first()).toContainText("Seeded chat 130");
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "older-chats-first-page.png") });

    const more = page.getByRole("button", { name: "Show older chats" });
    await more.click();
    await expect(list.getByRole("option")).toHaveCount(100);
    await more.click();
    await expect(list.getByRole("option")).toHaveCount(130);
    // Nothing is left to ask for.
    await expect(page.getByRole("button", { name: /older chats/ })).toHaveCount(0);

    // The oldest chat is the last row: scroll to it and open it.
    const oldest = list.getByRole("option", { name: /Seeded chat 1(?!\d)/ });
    await list.hover();
    await page.mouse.wheel(0, 200_000);
    await expect(oldest).toBeInViewport();
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "older-chats-130.png") });
    await oldest.click();
    await expect(
      page
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: "Seeded chat 1" }),
    ).toBeVisible({ timeout: 45_000 });

    // Opening a chat refreshes the list: it still shows all 130 chats, not just the first page.
    await expect(list.getByRole("option")).toHaveCount(130);
  },
);
