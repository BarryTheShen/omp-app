/// <reference types="node" />
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);

/** The fake model answers forty paragraphs for this keyword, so the chat runs well past one screen. */
const PROMPT = "long_reply_probe please";
const LAST_PARAGRAPH = "Paragraph 40 of a long reply.";

function banner(page: Page): Locator {
  return page.locator('[data-slot="u1-thread-error"]');
}

/** Ends the omp the app's server started for the chat the way an out-of-memory kill would. */
function killOmp(pids: readonly number[]): void {
  expect(pids).toHaveLength(1);
  for (const pid of pids) process.kill(pid, "SIGKILL");
}

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

/**
 * Issue #1295. omp stops while the reader is at the bottom of a chat longer than one screen. The "Restart omp" notice
 * must be in view there, in the footer under the chat, not above its first message. Restart omp from the notice starts
 * omp again and the notice goes. Captured in light, dark and at 390 px.
 */
realTest(
  "real omp: a chat longer than one screen shows the stopped-omp notice at its bottom, in view",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    await expect(page.getByText(LAST_PARAGRAPH)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });

    const killed = realApp.ompProcesses();
    killOmp(killed);

    const restart = banner(page).getByRole("button", { name: "Restart omp" });
    await expect(banner(page)).toContainText("omp exited (signal SIGKILL)", { timeout: 30_000 });
    await expect(restart).toBeVisible();
    // The reader is at the bottom of the chat: the notice is drawn there, so it is in view.
    await expect(banner(page)).toBeInViewport();
    await expect(restart).toBeInViewport();
    await expect(
      page.locator('[data-slot="u1-thread-footer"] [data-slot="u1-thread-error"]'),
    ).toHaveCount(1);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1295-exited-light.png") });

    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1295-exited-dark.png") });
    await setTheme(page, false);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(restart).toBeInViewport();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1295-exited-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    await restart.click();
    await expect(banner(page)).toBeHidden({ timeout: 90_000 });
    const restarted = realApp.ompProcesses();
    expect(restarted).toHaveLength(1);
    expect(restarted).not.toEqual(killed);
  },
);
