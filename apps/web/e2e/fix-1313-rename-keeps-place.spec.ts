import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1313. Renaming a chat keeps its place in the Sessions list: a rename is not activity, so the chat stays where
 * its newest message put it, after the rename and after a reload. The seeded chats are listed newest first, so "Seeded
 * chat 5" is the eighth row of twelve, and the rename must leave it there.
 */
realTest.use({ seedSessions: 12 });

/** Waits until the sessions drawer has finished sliding in, so a capture reads its final layout. */
async function waitForSessionsDrawerOpen(page: Page): Promise<void> {
  await expect(page.locator("#shell-sessions-sidebar")).not.toHaveAttribute("inert", "");
  await page.evaluate(async () => {
    const nextFrame = (): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => resolve());
      return promise;
    };
    await nextFrame();
    await nextFrame();
  });
  await waitForFiniteAnimations(page);
}

realTest(
  "renaming a chat keeps its place in the list, and a reload keeps it there",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const list = page.getByRole("listbox", { name: "Session list" });
    const rows = list.getByRole("option");
    await expect(rows).toHaveCount(12, { timeout: 30_000 });
    await expect(rows.nth(0)).toContainText("Seeded chat 12");
    await expect(rows.nth(7)).toContainText("Seeded chat 5");

    // Rename it from its row's More actions, as a person does with the mouse.
    await rows.nth(7).hover();
    await page.getByRole("button", { name: "More actions for Seeded chat 5" }).click();
    await page.getByRole("menuitem", { name: "Rename Seeded chat 5" }).click();
    const box = page.getByRole("textbox", { name: "Rename Seeded chat 5" });
    await box.fill("Five renamed by the spec");
    await box.press("Enter");

    await expect(rows.nth(7)).toContainText("Five renamed by the spec", { timeout: 45_000 });
    await expect(rows.nth(0)).toContainText("Seeded chat 12");

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1313-renamed-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1313-renamed-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.reload();
    await expect(rows).toHaveCount(12, { timeout: 30_000 });
    await expect(rows.nth(7)).toContainText("Five renamed by the spec", { timeout: 45_000 });
    await expect(rows.nth(0)).toContainText("Seeded chat 12");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await waitForSessionsDrawerOpen(page);
    await expect(rows.nth(7)).toContainText("Five renamed by the spec");
    await page.screenshot({ path: join(screenshots, "fix-1313-renamed-narrow.png") });
  },
);
