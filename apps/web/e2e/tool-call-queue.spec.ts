/// <reference types="node" />
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

/**
 * A bash call, then a write, in one message. Bash runs alongside other shared calls, but write is exclusive,
 * so omp starts it only when the bash has finished: while the bash runs, the write is queued. The queued write
 * must read Waiting, never Finished, No result recorded or Streaming, and both calls end with their results.
 */

const BASH = "tool-card-call_queued_bash";
const WRITE = "tool-card-call_queued_write";

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest.setTimeout(420_000);

realTest(
  "a call omp has not started reads Waiting while the call before it runs, and both calls end with their results",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "run_queued_pair");

    const bash = page.getByTestId(BASH);
    const write = page.getByTestId(WRITE);
    await expect(bash).toHaveAttribute("data-phase", "running", { timeout: 120_000 });

    // While the bash runs, the write has no state yet: it is queued, and its card says Waiting.
    await expect(write).toHaveAttribute("data-queued", "true", { timeout: 30_000 });
    await expect(write).toContainText("Waiting");
    await expect(write).not.toContainText("Finished");
    await expect(write).not.toContainText("No result recorded");
    await expect(write).not.toContainText("Streaming");
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "tool-call-queue-waiting-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "tool-call-queue-waiting-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(write).toHaveAttribute("data-queued", "true");
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "tool-call-queue-waiting-narrow.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Both calls end with their results: the write runs after the bash, and no card is left queued.
    await expect(bash).toHaveAttribute("data-phase", "success", { timeout: 180_000 });
    await expect(write).toHaveAttribute("data-phase", "success", { timeout: 180_000 });
    await expect(write).not.toHaveAttribute("data-queued", "true");
    await expect(bash).toContainText("Complete");
    await expect(write).toContainText("Complete");
    expect(realApp.problems).toEqual([]);
  },
);
