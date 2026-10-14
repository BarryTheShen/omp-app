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
 * Issue #908. The fake model starts one worker that finishes at once. Before the reload the task card reads Completed
 * (header, job row and worker row). After the reload the chat reopens, and the card must still read Completed: a
 * reload does not change a finished card's status. It used to read Running (and its worker row Pending) for as long
 * as the page stayed open.
 */
const TRIGGER = '[data-slot="u3-tool-card-trigger"]';
const JOB = '[data-slot="t5-task-job"]';
const PROGRESS = '[data-slot="t5-task-progress"]';

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest(
  "real omp: a finished worker's task card still reads Completed after a reload",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");
    // The task card starts as one line (#1162), and its body holds the worker's result: open it before reading that.
    const before = page.getByTestId("t5-task-card");
    await expect(before.first()).toBeVisible({ timeout: 120_000 });
    await openToolCard(before);
    // The worker's submission is one more collapsed card inside the task card: open it to read the worker's result.
    await expect(page.locator('[data-testid^="tool-card-call_yield"]').first()).toBeVisible({
      timeout: 120_000,
    });
    await openToolCard(page.locator('[data-testid^="tool-card-call_yield"]').first());
    await expect(page.getByText("Nested probe completed.").first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });

    await expect(before.locator(TRIGGER).first()).toHaveAttribute("aria-label", "task: Complete", {
      timeout: 60_000,
    });
    await expect(before.locator(JOB)).toContainText("Completed");

    await page.reload();
    // The chat reopens by itself. The card starts as one line again, so it is opened before its result is read.
    const reopened = page.getByTestId("t5-task-card");
    await expect(reopened.first()).toBeVisible({ timeout: 120_000 });
    await openToolCard(reopened);
    // The worker's submission is one more collapsed card inside the task card: open it to read the worker's result.
    await expect(page.locator('[data-testid^="tool-card-call_yield"]').first()).toBeVisible({
      timeout: 120_000,
    });
    await openToolCard(page.locator('[data-testid^="tool-card-call_yield"]').first());
    await expect(page.getByText("Nested probe completed.").first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });

    const after = page.getByTestId("t5-task-card");
    await expect(after.locator(TRIGGER).first()).toHaveAttribute("aria-label", "task: Complete", {
      timeout: 30_000,
    });
    await openToolCard(after);
    await expect(after.locator(JOB)).toContainText("Completed");
    await expect(after.locator(JOB)).not.toContainText("Running");
    await expect(after.locator(PROGRESS)).toContainText("Completed");
    await expect(after.locator(PROGRESS)).not.toContainText("Pending");

    await after.locator(TRIGGER).first().scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-908-reload-light.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-908-reload-dark.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await after.locator(TRIGGER).first().scrollIntoViewIfNeeded();
    await settle(page);
    await page.screenshot({ path: join(screenshots, "fix-908-reload-narrow.png"), fullPage: true });
    expect(realApp.problems).toEqual([]);
  },
);
