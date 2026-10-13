import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #1314. A branch's row in the Sessions list has one time line: the time the branch was made, on its own line
 * under the title. The row used to add the chat's last update as well ("Now"), so it read two times. The source row
 * keeps its own update time.
 */

/** Waits until the sessions drawer has finished sliding in, so a capture or a measurement reads its final layout. */
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
  "a branch row shows the time it was made and no update time, and its source row keeps its update time",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "count_reply alpha");
    await expect(page.getByText(/^count-\d+ alpha$/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Regenerate response" }).click();

    const list = page.getByRole("listbox", { name: "Session list" });
    const branch = list.getByRole("option").filter({ hasText: "Branch made" });
    const original = list.getByRole("option").filter({ hasNotText: "Branch made" });
    await expect(branch).toHaveCount(1);
    await expect(original).toHaveCount(1);
    expect(await branch.locator("time").count()).toBe(0);
    await expect(branch).not.toContainText(/\bNow\b|ago/);
    await expect(original.locator("time")).toHaveCount(1);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1314-branch-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1314-branch-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(branch).toBeVisible();
    await waitForSessionsDrawerOpen(page);
    await page.screenshot({ path: join(screenshots, "fix-1314-branch-narrow.png") });
  },
);
