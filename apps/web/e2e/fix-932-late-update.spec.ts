/// <reference types="node" />
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  openToolCard,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * The fake model answers `spawn_slow_with_sleep` with a task call and a 10 s bash call in one message. The task
 * call returns at once and starts a worker that takes 7 s. Its report (the job's end, a tool update for the task
 * call) reaches the page while the parent turn is still running, so the call is updated after it has ended. When
 * the turn settles, the call must still read Complete, never Cancelled.
 */
const TRIGGER = '[data-slot="u3-tool-card-trigger"]';
const COMPLETED = /Background job SlowProbe has completed/;

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest.setTimeout(420_000);

realTest(
  "a task whose worker reports while its turn runs still reads Complete, never Cancelled, once the turn settles",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    // The chat has loaded (the thread shows its empty state, not "Loading conversation"): a prompt typed while it
    // loads is lost when the draft loads.
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(composer, "spawn_slow_with_sleep");

    const card = page.getByTestId("t5-task-card");
    await expect(card).toBeVisible({ timeout: 120_000 });
    // The turn settles after its bash (10 s); the worker reported inside that turn. The job's completion message
    // then starts its resume turn, which must also settle without cancelling the call.
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText(COMPLETED)).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const trigger = card.locator(TRIGGER).first();
    // The resume turn's settle is the last event that could cancel the call: give it 3 s to finish before the check.
    await page.waitForTimeout(3_000);
    await expect(trigger).toHaveAttribute("aria-label", "task: Complete");
    // A finished card reads as one line: the cancelled note sits in its body, so the card opens for the check.
    await openToolCard(card);
    await expect(card).not.toContainText("Tool call cancelled.");

    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-932-task-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-932-task-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({
      path: join(screenshots, "fix-932-task-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
