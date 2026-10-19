import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { measureStep, readLog, recordMotion, type StepResult } from "./motion-metrics";
import { expect, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

/**
 * Motion and stability (#1173, part 1): a reply that streams must not move the composer. The steering
 * hint ("Enter steers this turn…") used to be a line above the editor that mounted when a turn started and
 * unmounted when it ended, so the composer jumped 24 px at both ends of every reply, and the Jump to latest
 * row moved with it. The hint now sits in the toolbar row, which has a fixed height. Each test streams a long
 * reply on real omp, records where the composer sits in every frame, and asserts that it never moves and
 * that the layout shift stays under 0.02. Each test also keeps a screenshot taken mid-reply.
 */

const TRACKED = { composer: '[data-shell-region="composer"]' } as const;

const DARK_THEME = (): void => {
  window.localStorage.setItem("omp-app.theme", "dark");
};

async function establishMessageBaseline(page: Page, composer: Locator): Promise<void> {
  await expect(page.locator('[data-empty-chat="true"]')).toBeVisible({ timeout: 60_000 });
  const emptyTop = await page.locator('[data-shell-region="composer"]').boundingBox();
  await sendPrompt(composer, "baseline message");
  await expect(page.locator('[data-slot="u1-message-row"][data-role="user"]').first()).toBeVisible({
    timeout: 60_000,
  });
  const messageTop = await page.locator('[data-shell-region="composer"]').boundingBox();
  expect(emptyTop?.y).toBeDefined();
  expect(messageTop?.y).toBeDefined();
  expect(Math.abs((emptyTop?.y ?? 0) - (messageTop?.y ?? 0))).toBeGreaterThan(1);
}

async function streamReply(
  page: Page,
  composer: Locator,
  label: string,
  hint: "visible" | "hidden",
): Promise<{ readonly step: StepResult; readonly sawComposer: boolean }> {
  const stop = page.getByRole("button", { name: "Stop generating" });
  const step = await measureStep(page, `streamed reply (${label})`, async () => {
    await sendPrompt(composer, "stream_long_code show the long block");
    await expect(stop).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Here is the long streamed block:")).toBeVisible();
    await mkdir(screenshots, { recursive: true });
    const steerHint = page.locator('[data-composer-steer-hint="true"]');
    if (hint === "visible") await expect(steerHint).toBeVisible();
    else {
      await expect(steerHint).toHaveCount(1);
      await expect(steerHint).toBeHidden();
    }
    await page.screenshot({ path: join(screenshots, `motion-stream-${label}.png`) });
    await expect(stop).toHaveCount(0, { timeout: 60_000 });
  });
  const log = await readLog(page);
  return { step, sawComposer: log.geometry.some((sample) => sample.name === "composer") };
}

realTest("a streamed reply does not move the composer (light)", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({
    beforeLoad: (target) => target.addInitScript(recordMotion, TRACKED),
  });
  const composer = await startChat(page);
  await establishMessageBaseline(page, composer);
  const { step, sawComposer } = await streamReply(page, composer, "light", "visible");
  expect(sawComposer, "the recorder followed the composer").toBe(true);
  expect(step.movedPx.composer ?? 0, "composer movement while the reply streams (px)").toBe(0);
  expect(step.layoutShift, "layout shift (CLS) while the reply streams").toBeLessThan(0.02);
});

realTest("a streamed reply does not move the composer (dark)", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.addInitScript(recordMotion, TRACKED);
      await target.addInitScript(DARK_THEME);
    },
  });
  const composer = await startChat(page);
  await establishMessageBaseline(page, composer);
  const { step, sawComposer } = await streamReply(page, composer, "dark", "visible");
  expect(sawComposer, "the recorder followed the composer").toBe(true);
  expect(step.movedPx.composer ?? 0, "composer movement while the reply streams (px)").toBe(0);
  expect(step.layoutShift, "layout shift (CLS) while the reply streams").toBeLessThan(0.02);
});

realTest("a streamed reply does not move the composer (390 px)", async ({ realApp }, testInfo) => {
  testInfo.setTimeout(240_000);
  const page = await realApp.open({
    beforeLoad: (target) => target.addInitScript(recordMotion, TRACKED),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Show sessions sidebar" }).click();
  const composer = await startChat(page);
  const drawerClose = page.locator('button[aria-label="Close open sidebar"]');
  if ((await drawerClose.count()) > 0) await drawerClose.click();
  await establishMessageBaseline(page, composer);
  const { step, sawComposer } = await streamReply(page, composer, "narrow", "hidden");
  expect(sawComposer, "the recorder followed the composer").toBe(true);
  expect(step.movedPx.composer ?? 0, "composer movement while the reply streams (px)").toBe(0);
  expect(step.layoutShift, "layout shift (CLS) while the reply streams").toBeLessThan(0.02);
});

realTest(
  "a streamed reply does not move the composer with both sidebars open at 1024 px, where the hint is hidden",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open({
      beforeLoad: (target) => target.addInitScript(recordMotion, TRACKED),
    });
    await page.setViewportSize({ width: 1024, height: 800 });
    const composer = await startChat(page);
    await establishMessageBaseline(page, composer);
    const { step, sawComposer } = await streamReply(page, composer, "wide-both-sidebars", "hidden");
    expect(sawComposer, "the recorder followed the composer").toBe(true);
    expect(step.movedPx.composer ?? 0, "composer movement while the reply streams (px)").toBe(0);
  },
);
