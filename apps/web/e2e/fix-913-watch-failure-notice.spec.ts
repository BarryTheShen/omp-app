import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

const NOTICE = '[data-watch-notice="true"]';

/** The notice when a folder's watch is refused for another reason: it says what happened and names no cause. */
const WATCH_FAILED_NOTICE =
  "omp app can't watch some of its files for changes. It checks them every second instead, so changes still show, a little later.";

/**
 * Runs `body` while the folder cannot be watched: without read permission the server's directory watch is refused
 * (EACCES), as a full computer refuses one (ENOSPC). Its files stay readable, so the app keeps running.
 */
async function whileUnwatchable<T>(folder: string, body: () => Promise<T>): Promise<T> {
  await chmod(folder, 0o311);
  try {
    return await body();
  } finally {
    await chmod(folder, 0o755);
  }
}

realTest(
  "says that a file the app cannot watch is checked by polling, and clears the notice once the watch opens again",
  async ({ realApp }) => {
    const page: Page = await whileUnwatchable(realApp.agentDir, async () => {
      // The server's start-up subscriptions (rules, extensions) watch the nearest folder that exists, which is
      // the agent folder here. They were opened before the folder became unreadable, so a restart tries again.
      await realApp.restartServer();
      const opened = await realApp.open();
      const notice = opened.locator(NOTICE);
      await expect(notice.getByText(WATCH_FAILED_NOTICE, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(notice.getByRole("button", { name: "Dismiss" })).toBeVisible();
      await expect(notice).not.toContainText("Closing programs that watch many files");
      await expect(notice).toHaveCSS("font-size", "12px");
      await opened.screenshot({ path: join(screenshots, "fix-1075-watch-failed-light.png") });
      const darkPage = await realApp.open({
        beforeLoad: (target) =>
          target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
      });
      const darkNotice = darkPage.locator(NOTICE);
      await expect(darkNotice.getByText(WATCH_FAILED_NOTICE, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(darkPage.locator("html")).toHaveClass(/dark/);
      await expect(darkNotice).toHaveCSS("font-size", "12px");
      await waitForFiniteAnimations(darkPage);
      await darkPage.screenshot({ path: join(screenshots, "fix-1075-watch-failed-dark.png") });
      await opened.setViewportSize({ width: 390, height: 844 });
      await waitForFiniteAnimations(opened);
      await expect(notice.getByText(WATCH_FAILED_NOTICE, { exact: true })).toBeVisible();
      await expect(notice).toHaveCSS("font-size", "12px");
      await notice.screenshot({ path: join(screenshots, "fix-1075-watch-failed-390.png") });
      return opened;
    });
    // Once the folder is readable the server opens the watch within a second, and the page reads the server's
    // state every ten seconds, so the notice goes away without a reload.
    await expect(page.locator(NOTICE)).toHaveCount(0, { timeout: 40_000 });
    expect(realApp.problems).toEqual([]);
  },
);
