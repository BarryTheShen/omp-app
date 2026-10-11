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

/**
 * #865 on real omp, while a turn runs: the composer says how to queue a message (Ctrl+Enter here, Cmd+Enter on a
 * Mac), and a queued follow-up sits under 'After this turn', not 'After yield'. Captured in light, dark and at 390 px.
 */

const HINT = "Enter steers this turn. Ctrl+Enter queues a message for after it.";

realTest.setTimeout(420_000);

function queueBar(page: Page): Locator {
  return page.getByRole("complementary", { name: "Queued messages" });
}

/** Sends run_queued_pair and waits until the turn runs: the composer offers Stop while it does. */
async function startQueuedRun(page: Page, composer: Locator): Promise<void> {
  await sendPrompt(composer, "run_queued_pair");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 120_000,
  });
}

/** While the turn runs: the hint names the chord, and a follow-up goes under the lane named in plain words. */
async function queueAFollowUp(page: Page, composer: Locator): Promise<void> {
  await composer.fill("follow later please");
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();
  await composer.press("Control+Enter");
  await expect(
    queueBar(page)
      .getByRole("region", { name: "After this turn" })
      .getByText("follow later please", { exact: true }),
  ).toBeVisible();
  await expect(queueBar(page).getByRole("region", { name: "After yield" })).toHaveCount(0);
}

realTest(
  "in light, a running turn names the queue chord and queues a follow-up under After this turn",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 800 });
    const composer = await startChat(page);
    await startQueuedRun(page, composer);
    await queueAFollowUp(page, composer);
    await waitForFiniteAnimations(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-865-queue-light.png"), fullPage: true });
  },
);

realTest("in dark, the same running turn reads the same", async ({ realApp }) => {
  // The saved theme is set before the page loads, the way a person who chose Dark gets it.
  const page = await realApp.open({
    beforeLoad: (openPage) =>
      openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await startQueuedRun(page, composer);
  await queueAFollowUp(page, composer);
  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-865-queue-dark.png"), fullPage: true });
});

realTest("at 390 px, the hint and the queue lane fit the screen", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await startQueuedRun(page, composer);
  await queueAFollowUp(page, composer);
  // The resize comes after the chat starts and the follow-up queues: a sidebar that narrows while the chat is still
  // starting is not stable enough to click.
  await page.setViewportSize({ width: 390, height: 844 });
  await composer.fill("a second follow-up");
  await expect(page.getByText(HINT, { exact: true })).toBeVisible();
  const hint = await page.getByText(HINT, { exact: true }).boundingBox();
  expect((hint?.x ?? 0) + (hint?.width ?? 0)).toBeLessThanOrEqual(390);
  const bar = await queueBar(page).boundingBox();
  expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(390);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-865-queue-narrow.png"), fullPage: true });
});
