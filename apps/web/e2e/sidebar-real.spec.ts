import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Feedback #661: with about 20 sessions the list was cut off at the bottom of the window and older
 * chats could not be reached. This is the real app (real server, real omp) with 40 old chats in the
 * folder (under the sidebar's page of 50), in a window short enough that they cannot all fit.
 */
realTest.use({ seedSessions: 40 });

realTest(
  "with 40 chats the sidebar scrolls, and the oldest chat can be reached and opened",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 600 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option").first()).toBeVisible({ timeout: 30_000 });
    // The newest chat is first (the sidebar names a chat after its first prompt).
    await expect(list.getByRole("option").first()).toContainText("Seeded chat 40");

    const metrics = await list.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      bottom: element.getBoundingClientRect().bottom,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.bottom).toBeLessThanOrEqual(600);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
      600,
    );

    const oldest = list.getByRole("option", { name: /Seeded chat 1(?!\d)/ });
    await expect(oldest).not.toBeInViewport();
    await list.hover();
    await page.mouse.wheel(0, 50_000);
    await expect(oldest).toBeInViewport();
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "sidebar-real-40-chats.png") });

    await oldest.click();
    await expect(
      page
        .locator('[data-slot="u1-message-row"][data-role="user"]')
        .filter({ hasText: "Seeded chat 1" }),
    ).toBeVisible({ timeout: 45_000 });
  },
);
