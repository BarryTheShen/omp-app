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
 * A task call starts one background worker, and the worker fails on the fake provider's 400. The Agents tab
 * opens first, so the roster is subscribed before the worker starts and sees it fail. The task card must then
 * read Failed, the same as the Agents list: its header and its job row used to keep omp's result from when the
 * call returned, which said Running.
 */

/** Lets finite transitions settle before a screenshot. Bounded: a transition a headless page never finishes must not hang the case. */
async function settle(page: Page): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, 5_000);
  await Promise.race([waitForFiniteAnimations(page), promise]);
  clearTimeout(timer);
}

realTest.setTimeout(300_000);

realTest(
  "a task card whose only worker failed reads Failed, not Running, as the Agents list does",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await page.getByRole("tab", { name: "Agents" }).click();
    await sendPrompt(composer, "spawn_failing_subagent");

    const hub = page.getByRole("region", { name: "Agent Hub" });
    await expect(hub).toContainText("FailProbe", { timeout: 120_000 });
    await expect(hub).toContainText("Failed", { timeout: 120_000 });

    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 120_000 });
    const card = page.getByTestId("t5-task-card");
    await expect(card.locator('[data-slot="u3-tool-card-trigger"]')).toContainText(
      "Failed · 1 agent",
    );
    await expect(card.locator('[data-slot="u3-tool-card-status"]')).toHaveText("Failed");
    await openToolCard(card);
    await expect(card.locator('[data-slot="t5-task-job"]')).toContainText("Failed");
    await expect(card.locator('[data-slot="t5-task-job"]')).not.toContainText("Running");
    await expect(card.locator('[data-slot="t5-task-transcripts"]')).toContainText("Failed");

    // The captures show the card itself (the transcript scrolls inside a box, so a page capture would show its end).
    await settle(page);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: join(screenshots, "t5-failed-worker-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settle(page);
    await card.screenshot({ path: join(screenshots, "t5-failed-worker-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: join(screenshots, "t5-failed-worker-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 900 });

    expect(realApp.problems).toEqual([]);
  },
);
