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

declare global {
  interface Window {
    /** Set by the page's observer when the empty copy is on screen (see the spec below). */
    emptyCopySeen?: boolean;
  }
}

/**
 * Issue #1294. A chat that reopens after a reload may have its process up before its history is read. While that read
 * runs the thread must say "Loading conversation…", never "No messages yet.", which tells the person the chat is empty.
 * An observer installed before the reload records every frame in which the empty copy is on screen. The reopened chat
 * is captured in light, dark and at 390 px.
 */
const EMPTY_SLOT = '[data-slot="u1-thread-empty"]';
/** The fake model answers "pong" to a prompt with no keyword; the prompt itself does not contain the word. */
const ANSWER = "pong";

async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await waitForFiniteAnimations(page);
}

realTest(
  "real omp: a chat that reopens after a reload never says 'No messages yet.' while its history loads",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "hello there");
    await expect(page.getByText(ANSWER, { exact: true })).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });

    await page.addInitScript(() => {
      window.emptyCopySeen = false;
      document.addEventListener("DOMContentLoaded", () => {
        const check = () => {
          if (document.querySelector('[data-slot="u1-thread-empty"]') !== null) {
            window.emptyCopySeen = true;
          }
        };
        new MutationObserver(check).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      });
    });

    await page.reload();
    // The chat reopens by itself: its answer is on screen again, and the chat has settled.
    await expect(page.getByText(ANSWER, { exact: true })).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(EMPTY_SLOT)).toHaveCount(0);
    expect(await page.evaluate(() => window.emptyCopySeen)).toBe(false);

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1294-reopened-light.png") });
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-1294-reopened-dark.png") });
    await setTheme(page, false);

    // At this width both side drawers are closed, so the capture shows the chat alone.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1294-reopened-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(realApp.problems).toEqual([]);
  },
);
