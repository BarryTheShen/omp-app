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

/** A transcript row by its role, found by the text it shows. */
function row(page: Page, role: "user" | "assistant", text: string) {
  return page.locator(`[data-slot="u1-message-row"][data-role="${role}"]`, { hasText: text });
}

/** The thread's root, which is marked while omp works. */
function threadRoot(page: Page) {
  return page.locator('[data-slot="u1-thread-root"]');
}

/**
 * A saved user row, with its action bar, is in the page while omp streams a long reply (`stream_long_code`, about 13
 * seconds). Its Edit button is out of the accessibility tree during the run and back when the run ends. The chat opens
 * at the desktop width; the window is then sized for the case before the second prompt is sent.
 */
async function editWhileRunning(
  page: Page,
  tag: string,
  shot: string,
  width: { width: number; height: number },
): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, `count_reply ${tag}`);
  await expect(page.getByText(new RegExp(`^count-\\d+ ${tag}$`))).toBeVisible({
    timeout: 60_000,
  });
  const saved = row(page, "user", `count_reply ${tag}`);
  const edit = saved.getByRole("button", { name: "Edit", exact: true });
  await expect(edit).toBeVisible();

  await page.setViewportSize(width);
  await sendPrompt(composer, `stream_long_code ${tag}`);
  await expect(threadRoot(page)).toHaveAttribute("data-thread-running", "true", {
    timeout: 60_000,
  });
  await expect(saved.locator('[data-slot="p3-message-actions"]')).toHaveCount(1);
  await expect(edit).toHaveCount(0);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, `${shot}-running.png`) });

  await expect(threadRoot(page)).not.toHaveAttribute("data-thread-running", "true", {
    timeout: 150_000,
  });
  await expect(edit).toBeVisible({ timeout: 60_000 });
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, `${shot}-settled.png`) });
}

realTest.describe("a user row's Edit action waits for a run to end", () => {
  realTest("light, 1280 px", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(400_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await editWhileRunning(page, "light", "fix-2571-light", { width: 1280, height: 900 });
  });

  realTest("dark, 1280 px", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(400_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await editWhileRunning(page, "dark", "fix-2571-dark", { width: 1280, height: 900 });
  });

  realTest("light, 390 px", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(400_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    await editWhileRunning(page, "narrow", "fix-2571-narrow", { width: 390, height: 844 });
  });
});
