/// <reference types="node" />
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
 * Stop with queued messages gives them back to the message box, oldest first, and starts no new run
 * (issue 1198). `stream_long_code` streams a long reply, so the turn stays open while messages are queued.
 */

const STOP = "Stop generating";
const RESTORED = "Stopped. The queued messages are back in the message box.";
const FIRST = "first queued message";
const SECOND = "second queued message";
const BOTH = `${FIRST}\n\n${SECOND}`;

realTest.setTimeout(420_000);

function queueBar(page: Page): Locator {
  return page.getByRole("complementary", { name: "Queued messages" });
}

function afterThisTurn(page: Page): Locator {
  return queueBar(page).getByRole("region", { name: "After this turn" });
}

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Sends a prompt that streams for a long time and waits until the composer offers Stop. */
async function startLongRun(page: Page, composer: Locator): Promise<Locator> {
  await sendPrompt(composer, "stream_long_code please");
  const stop = page.getByRole("button", { name: STOP });
  await expect(stop).toBeVisible({ timeout: 120_000 });
  return stop;
}

/** Queues a follow-up while the turn runs (Control+Enter) and waits until the queue shows it. */
async function queueFollowUp(page: Page, composer: Locator, text: string): Promise<void> {
  await composer.fill(text);
  await composer.press("Control+Enter");
  // The lane shows the follow-up once omp has queued it: a round trip to omp, which waits on a loaded machine.
  await expect(afterThisTurn(page).getByText(text, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Two follow-ups queued during the run, then Stop: the shared setup of the restore cases. */
async function stopWithTwoQueued(page: Page, composer: Locator): Promise<void> {
  const stop = await startLongRun(page, composer);
  await queueFollowUp(page, composer, FIRST);
  await queueFollowUp(page, composer, SECOND);
  await stop.click();
  await expect(composer).toHaveValue(BOTH);
}

realTest(
  "Stop gives the queued follow-ups back in order and starts no new run",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await stopWithTwoQueued(page, composer);

    await expect(queueBar(page).getByText(FIRST, { exact: true })).toHaveCount(0);
    await expect(queueBar(page).getByText(SECOND, { exact: true })).toHaveCount(0);
    await expect(page.getByText(RESTORED)).toBeVisible();
    // A new run would start right after the abort. Give it time to appear, then check it did not.
    await pause(5_000);
    await expect(page.getByRole("button", { name: STOP })).toHaveCount(0);
    await expect(composer).toHaveValue(BOTH);
    expect(realApp.problems).toEqual([]);
  },
);

realTest("Stop with nothing queued stops the run and leaves the box empty", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  const stop = await startLongRun(page, composer);
  await stop.click();

  await expect(page.getByRole("button", { name: STOP })).toHaveCount(0);
  await expect(composer).toHaveValue("");
  await expect(page.getByText(RESTORED)).toHaveCount(0);
  expect(realApp.problems).toEqual([]);
});

realTest("the restored messages in light theme, and at 390 px", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await stopWithTwoQueued(page, composer);
  await expect(page.getByText(RESTORED)).toBeVisible();

  await settle(page);
  await page.screenshot({ path: join(screenshots, "stop-1198-after-light.png"), fullPage: true });
  const desktop = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await settle(page);
  await page.screenshot({ path: join(screenshots, "stop-1198-after-narrow.png"), fullPage: true });
  if (desktop) await page.setViewportSize(desktop);
});

realTest("the restored messages in dark theme", async ({ realApp }) => {
  // The saved theme is set before the page loads, the way a person who chose Dark gets it.
  const page = await realApp.open({
    beforeLoad: (openPage) =>
      openPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
  });
  const composer = await startChat(page);
  await stopWithTwoQueued(page, composer);

  await expect(page.locator("html")).toHaveClass(/\bdark\b/);
  await settle(page);
  await page.screenshot({ path: join(screenshots, "stop-1198-after-dark.png"), fullPage: true });
});
