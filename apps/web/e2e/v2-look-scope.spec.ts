import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The app's look for every device or this one (V258): two devices on Every device share it, a change on one shows on
 * the other at once; a device on This device keeps its own and gets it back after a time on Every device.
 */
const openLook = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator('[data-tour="settings-tab-app"]').click();
};
const style = (page: Page) => page.locator("html");
const choose = (page: Page, name: string) =>
  page.getByRole("group", { name: "Whose look" }).getByRole("button", { name, exact: true });
/** A style's button in Settings → App → Look → Style. */
const pickStyle = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Style" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .click();

realTest.describe("the look for every device or this one", () => {
  realTest.use({ seedSessions: 1 });

  realTest(
    "Every device shares the look across devices; This device keeps its own, and gets it back",
    async ({ realApp, browser }, testInfo) => {
      testInfo.setTimeout(180_000);
      const desktop = await realApp.open({ path: "/" });
      const context = await browser.newContext();
      const other = await realApp.open({ path: "/", context });
      for (const page of [desktop, other])
        await expect(
          page
            .getByRole("navigation", { name: "Chats" })
            .getByRole("button", { name: "Seeded chat 1" }),
        ).toBeVisible({ timeout: 120_000 });

      // Both on Every device (a new device's start): the desktop's style shows on the other device too.
      await openLook(desktop);
      await expect(choose(desktop, "Every device")).toHaveAttribute("aria-pressed", "true");
      await pickStyle(desktop, "Paper");
      await expect(style(desktop)).toHaveAttribute("data-style", "paper");
      await expect(style(other)).toHaveAttribute("data-style", "paper", { timeout: 15_000 });
      await expect
        .poll(() => readFile(join(realApp.appDataDir, "app-look.json"), "utf8").catch(() => ""))
        .toContain('"style": "paper"');

      // The other device on This device: its own style, untouched by the desktop's changes.
      await openLook(other);
      await choose(other, "This device").click();
      await pickStyle(other, "Console");
      await expect(style(other)).toHaveAttribute("data-style", "console");
      await pickStyle(desktop, "Blocks");
      await expect(style(desktop)).toHaveAttribute("data-style", "blocks");
      await other.waitForTimeout(1_500);
      await expect(style(other)).toHaveAttribute("data-style", "console");

      // Back on Every device it shows the shared look; on This device again, its own comes back.
      await choose(other, "Every device").click();
      await expect(style(other)).toHaveAttribute("data-style", "blocks");
      await choose(other, "This device").click();
      await expect(style(other)).toHaveAttribute("data-style", "console");

      // After a reload, from the first paint, each device keeps its scope's look.
      await other.reload();
      await expect(style(other)).toHaveAttribute("data-style", "console");
      await desktop.reload();
      await expect(style(desktop)).toHaveAttribute("data-style", "blocks");
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );
});
