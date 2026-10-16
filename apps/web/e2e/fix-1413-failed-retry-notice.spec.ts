import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/** The fake provider answers every retry of this prompt with a transient HTTP 503. */
realTest(
  "a provider error that omp retries to exhaustion appears as a failed-retry transcript notice",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "retry_failure_probe");

    const notice = page.locator('[data-dedupe-key="retry:result"]');
    await expect(notice).toBeVisible({ timeout: 360_000 });
    await expect(notice).toHaveAttribute("data-severity", "error");
    await expect(notice).toContainText(
      /^Retry failed after \d+ attempts?: .*fake provider retry failure.*$/,
    );
    await notice.scrollIntoViewIfNeeded();
    await mkdir(screenshots, { recursive: true });

    // The error notice uses the app's styled danger surface before either capture.
    await expect(notice).toHaveCSS("border-top-width", "1px");
    await expect(notice).toHaveCSS("background-color", /^(rgb|oklch)/);
    await page.screenshot({
      path: join(screenshots, "fix-1413-failed-retry-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expect(notice).toHaveCSS("border-top-width", "1px");
    await expect(notice).toHaveCSS("background-color", /^(rgb|oklch)/);
    await page.screenshot({
      path: join(screenshots, "fix-1413-failed-retry-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expect(notice).toBeVisible();
    await expect(notice).toHaveCSS("border-top-width", "1px");
    await expect(notice).toHaveCSS("background-color", /^(rgb|oklch)/);
    await notice.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(screenshots, "fix-1413-failed-retry-390.png"),
      fullPage: true,
    });

    expect(realApp.problems).toEqual([]);
  },
);
