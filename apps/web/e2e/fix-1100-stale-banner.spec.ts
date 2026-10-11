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

const NARROW = { width: 390, height: 844 } as const;
/** The fake model answers this keyword with HTTP 400, the way a provider rejects a request. */
const FAILING_PROMPT = "fail_probe_child please";
/** A later prompt the fake model answers with "pong": the conversation goes on. */
const LATER_PROMPT = "hello after the error";
/** The answer itself; its thinking text ("I will answer pong.") is not matched. */
const ANSWER = { exact: true } as const;

realTest(
  "a banner for a failed prompt clears once a later prompt is answered",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, FAILING_PROMPT);
    const banner = page.locator('[data-slot="u1-thread-error"]');
    await expect(banner).toBeVisible({ timeout: 120_000 });

    await sendPrompt(composer, LATER_PROMPT);
    await expect(page.getByText("pong", ANSWER)).toBeVisible({ timeout: 60_000 });
    // The conversation went on, so the banner of the failed prompt is gone.
    await expect(banner).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1100-stale-banner-light.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("the banner clears in dark and at 390 px too", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(180_000);
  const page = await realApp.open({
    beforeLoad: (target) =>
      target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  await expect(page.locator("html")).toHaveClass(/dark/);
  const composer = await startChat(page);
  await sendPrompt(composer, FAILING_PROMPT);
  const banner = page.locator('[data-slot="u1-thread-error"]');
  await expect(banner).toBeVisible({ timeout: 120_000 });
  await sendPrompt(composer, LATER_PROMPT);
  await expect(page.getByText("pong", ANSWER)).toBeVisible({ timeout: 60_000 });
  await expect(banner).toHaveCount(0);

  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, "fix-1100-stale-banner-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize(NARROW);
  await expect(page.getByText("pong", ANSWER)).toBeVisible();
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(fits).toBe(true);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1100-stale-banner-narrow.png"),
    fullPage: true,
  });
  expect(realApp.problems).toEqual([]);
});
