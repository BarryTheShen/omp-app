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
 * Issue 1226. omp moves a long bash command to the background, and the app had no way to end that job. While the job
 * runs, its bash card has a Stop button. Stop sends `/jobs kill <that card's job id>` through the command gateway and
 * shows omp's outcome in plain English on that card. `run_background_job` starts one long job; `run_background_pair`
 * starts two, and stopping one leaves the other running.
 */

realTest.setTimeout(420_000);

const DESKTOP = { width: 1280, height: 1000 } as const;
const NARROW = { width: 390, height: 844 } as const;

/** The bash card whose command contains `command`. */
function bashCard(page: Page, command: string): Locator {
  return page.getByTestId("u3-bash-card").filter({ hasText: command });
}

realTest("Stop ends that background job and the card says so", async ({ realApp }) => {
  const page = await realApp.open();
  await page.setViewportSize(DESKTOP);
  const composer = await startChat(page);
  await sendPrompt(composer, "run_background_job");
  const card = bashCard(page, "sleep 120; echo job-0");
  await expect(card).toContainText("In background", { timeout: 180_000 });
  await openToolCard(card);
  const stop = card.getByRole("button", { name: /^Stop background job bg_\d+$/ });
  await expect(stop).toHaveCount(1);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1226-running-light.png"), fullPage: true });
  await stop.click();
  await expect(card.getByRole("status")).toHaveText(/^Stopped background job bg_\d+\.$/);
  await expect(card.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await expect(card).toContainText(/Background job bg_\d+\./);
  await expect(card.getByText("Stopped", { exact: true })).toBeVisible();
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1226-stopped-light.png"), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1226-stopped-dark.png"), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize(NARROW);
  await waitForFiniteAnimations(page);
  await page.screenshot({ path: join(screenshots, "fix-1226-stopped-narrow.png"), fullPage: true });
});

realTest("Stop on one card leaves the other background job running", async ({ realApp }) => {
  const page = await realApp.open();
  const composer = await startChat(page);
  await sendPrompt(composer, "run_background_pair");
  const first = bashCard(page, "sleep 120; echo job-0");
  const second = bashCard(page, "sleep 120; echo job-1");
  await expect(first).toContainText("In background", { timeout: 180_000 });
  await expect(second).toContainText("In background");
  await openToolCard(first);
  await openToolCard(second);
  const firstStop = first.getByRole("button", { name: /^Stop background job bg_\d+$/ });
  await expect(firstStop).toHaveCount(1);
  await firstStop.click();
  await expect(first.getByRole("status")).toHaveText(/^Stopped background job bg_\d+\.$/);
  await expect(second).toContainText(/Running in the background as job bg_\d+/);
  const stillRunning = second.getByRole("button", { name: /^Stop background job bg_\d+$/ });
  await expect(stillRunning).toHaveCount(1);
  await stillRunning.click();
  await expect(second.getByRole("status")).toHaveText(/^Stopped background job bg_\d+\.$/);
});
