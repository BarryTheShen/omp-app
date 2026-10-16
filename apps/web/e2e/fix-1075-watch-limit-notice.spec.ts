import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const NOTICE = '[data-watch-notice="true"]';
const LIMIT_NOTICE =
  "omp app can't watch some of its files for changes, because this computer has no file watchers left. Closing programs that watch many files, such as editors, may free some. It checks them every second instead, so changes still show, a little later.";
const NARROW = { width: 390, height: 844 } as const;

realTest.use({ fileWatchFailure: "watcher-limit" });
realTest.setTimeout(300_000);

realTest(
  "shows the watcher-limit remedy and keeps a dismissed notice hidden after switching chats",
  async ({ realApp }) => {
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open();
    await startChat(page);
    const notice = page.locator(NOTICE);
    await expect(notice.getByText(LIMIT_NOTICE, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(notice.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expect(notice).toHaveCSS("font-size", "12px");
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1075-watch-limit-light.png") });

    const darkPage = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await startChat(darkPage);
    const darkNotice = darkPage.locator(NOTICE);
    await expect(darkNotice.getByText(LIMIT_NOTICE, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(darkPage.locator("html")).toHaveClass(/dark/);
    await expect(darkNotice).toHaveCSS("font-size", "12px");
    await waitForFiniteAnimations(darkPage);
    await darkPage.screenshot({ path: join(screenshots, "fix-1075-watch-limit-dark.png") });

    await page.setViewportSize(NARROW);
    await waitForFiniteAnimations(page);
    await expect(notice.getByText(LIMIT_NOTICE, { exact: true })).toBeVisible();
    await expect(notice).toHaveCSS("font-size", "12px");
    await notice.screenshot({ path: join(screenshots, "fix-1075-watch-limit-390.png") });

    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.locator(NOTICE)).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .locator('[aria-label="Sessions"]')
      .getByRole("button", { name: "New chat" })
      .first()
      .click();
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(NOTICE)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
