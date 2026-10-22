import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { measureStep, recordMotion } from "./motion-metrics";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue #2316: a prompt sent while a reply streams waits in the "Queued messages" row. That row used to sit inside the
 * composer, so its appearance pushed the composer up by 88 px and its leaving pulled it down again: a jump a person sees
 * while the agent replies. The row now sits in the notices row above the composer, which takes its own space, so the
 * composer stays where it is. Each test queues one prompt behind a long reply on real omp, records where the composer
 * sits in every frame, and saves a screenshot with the row shown.
 */

const TRACKED = { composer: '[data-shell-region="composer"]' } as const;

const DARK_THEME = (): void => {
  window.localStorage.setItem("omp-app.theme", "dark");
};

async function queueBehindReply(page: Page, composer: Locator, label: string): Promise<void> {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const queued = page.getByRole("complementary", { name: "Queued messages" });
  await sendPrompt(composer, "stream_long_code show the long block");
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Here is the long streamed block:")).toBeVisible();
  // The row's place is read while the message waits, inside the step; it is checked last, so the screenshot and the movement
  // assertion come first.
  const seen: { above?: boolean } = {};
  const step = await measureStep(page, `queued behind a reply (${label})`, async () => {
    await sendPrompt(composer, "ping");
    await expect(queued).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, `fix-2316-queued-${label}.png`) });
    const queuedBox = await queued.boundingBox();
    const cardBox = await page.locator('[data-composer-card="true"]').boundingBox();
    seen.above =
      queuedBox !== null && cardBox !== null && queuedBox.y + queuedBox.height <= cardBox.y + 0.5;
    await expect(queued).toHaveCount(0, { timeout: 60_000 });
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
  });
  expect(step.movedPx.composer ?? 0, "composer movement while a queued message waits (px)").toBe(0);
  expect(step.layoutShift, "layout shift (CLS) while a queued message waits").toBeLessThan(0.02);
  // The row sits in the notices row above the composer card (layout.ts, threadNotices).
  expect(seen.above, "the queued messages sit above the composer card").toBe(true);
}

realTest(
  "a queued message does not move the composer while a reply streams",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) => target.addInitScript(recordMotion, TRACKED),
    });
    const composer = await startChat(page);
    await queueBehindReply(page, composer, "light");
  },
);

realTest(
  "a queued message does not move the composer in dark mode",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await target.addInitScript(recordMotion, TRACKED);
        await target.addInitScript(DARK_THEME);
      },
    });
    const composer = await startChat(page);
    await queueBehindReply(page, composer, "dark");
  },
);

realTest("a queued message does not move the composer at 390 px", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({
    beforeLoad: (target) => target.addInitScript(recordMotion, TRACKED),
  });
  const composer = await startChat(page);
  // The width changes before the message is sent: the session list narrows away at a phone's width.
  await page.setViewportSize({ width: 390, height: 844 });
  await queueBehindReply(page, composer, "390");
});
