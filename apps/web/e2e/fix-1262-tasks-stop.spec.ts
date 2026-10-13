import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
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
 * Issue 1262, part of 1177. The Tasks view (the wait card) lists background jobs. While a job runs, its row has a Stop
 * control that sends `/jobs kill <id>` through the chat's command gateway, and Stop all sends `/jobs kill all`. Each
 * shows omp's answer in plain English. `run_background_pair` starts two long jobs; `wait_for_jobs` makes the wait tool
 * block on the chat's running jobs, so its card lists them.
 */

realTest.setTimeout(420_000);

const DESKTOP = { width: 1280, height: 1000 } as const;
const NARROW = { width: 390, height: 844 } as const;

/** The bash card whose command contains `command`. */
function bashCard(page: Page, command: string): Locator {
  return page.getByTestId("u3-bash-card").filter({ hasText: command });
}

/** The wait card's row for the job whose command contains `command`. */
function jobRow(wait: Locator, command: string): Locator {
  return wait.locator("li").filter({ hasText: command });
}

realTest("the Tasks view stops one job, then Stop all ends the rest", async ({ realApp }) => {
  const page = await realApp.open();
  await page.setViewportSize(DESKTOP);
  const composer = await startChat(page);
  await sendPrompt(composer, "run_background_pair");
  await expect(bashCard(page, "sleep 120; echo job-0")).toContainText("In background", {
    timeout: 180_000,
  });
  await expect(bashCard(page, "sleep 120; echo job-1")).toContainText("In background");
  await sendPrompt(composer, "wait_for_jobs");
  const wait = page.getByTestId("t5-wait-card");
  await openToolCard(wait);
  const first = jobRow(wait, "sleep 120; echo job-0");
  const second = jobRow(wait, "sleep 120; echo job-1");
  const firstStop = first.getByRole("button", { name: /^Stop background job bg_\d+$/ });
  await expect(firstStop).toHaveCount(1, { timeout: 180_000 });
  await expect(second.getByRole("button", { name: /^Stop background job bg_\d+$/ })).toHaveCount(1);
  await expect(wait.getByRole("button", { name: "Stop all background jobs" })).toHaveCount(1);
  await waitForFiniteAnimations(page);
  // Keyboard: the first Stop takes focus from the keyboard and shows a focus ring, and Enter stops that job.
  const resting = await firstStop.evaluate((el) => getComputedStyle(el).boxShadow);
  await firstStop.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(firstStop).toBeFocused();
  expect(await firstStop.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  await expect
    .poll(() => firstStop.evaluate((el) => getComputedStyle(el).boxShadow))
    .not.toBe(resting);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1262-running-light.png"), fullPage: true });

  await page.keyboard.press("Enter");
  await expect(first.getByRole("status")).toHaveText(/^Stopped background job bg_\d+\.$/);
  await expect(first.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);
  await expect(second.getByRole("button", { name: /^Stop background job bg_\d+$/ })).toHaveCount(1);
  await expect(wait.getByRole("button", { name: "Stop all background jobs" })).toHaveCount(1);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1262-stopped-one-light.png"),
    fullPage: true,
  });

  await wait.getByRole("button", { name: "Stop all background jobs" }).click();
  await expect(wait.getByText("Stopped 1 background job.", { exact: true })).toBeVisible();
  await expect(wait.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await expect(second.getByText("Cancelled", { exact: true })).toHaveCount(1);
  await expect(second.getByText("Running", { exact: true })).toHaveCount(0);
  await expect(wait).toContainText("2 cancelled");
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1262-stopped-all-light.png"),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1262-stopped-all-dark.png"),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize(NARROW);
  await waitForFiniteAnimations(page);
  await page.screenshot({
    path: join(screenshots, "fix-1262-stopped-all-narrow.png"),
    fullPage: true,
  });
});

realTest(
  "the Tasks view stops a running subagent, and the wait card shows it cancelled",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);
    // The steerable worker runs until a steer reaches it, so it is still running when the wait card lists it.
    await sendPrompt(composer, "spawn_steerable_subagent start the worker and wait for it");
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 180_000 });
    await sendPrompt(composer, "wait_for_jobs");
    const wait = page.getByTestId("t5-wait-card");
    await openToolCard(wait);
    const worker = wait.locator("li").filter({ hasText: "SteerProbe" });
    const stop = worker.getByRole("button", { name: /^Stop background job / });
    await expect(stop).toHaveCount(1, { timeout: 180_000 });
    await stop.click();
    // Under load omp's answer to a subagent's stop arrived after the default 5 s, so the answer itself is awaited.
    await expect(worker.getByRole("status")).toHaveText("Stopped background job SteerProbe.", {
      timeout: 60_000,
    });
    await expect(worker.getByText("Cancelled", { exact: true })).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(worker.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);
    await expect(wait).toContainText("1 cancelled", { timeout: 60_000 });
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1262-subagent-stopped-light.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1262-subagent-stopped-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize(NARROW);
    await wait.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1262-subagent-stopped-narrow.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
