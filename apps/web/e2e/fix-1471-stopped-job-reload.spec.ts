import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
 * Issue #1471 on real omp. A background bash job is stopped from its card, then the page reloads. The card used to read
 * the job as running again: the chip "In background", the running line and a Stop button. The stop was kept only in the
 * page's state, so a reload lost it. `run_background_job` starts `sleep 120; echo job-0` in the background.
 */
const COMMAND = "sleep 120; echo job-0";

realTest.setTimeout(300_000);

realTest(
  "a stopped background job's card still says it was stopped after the page reloads",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const composer = await startChat(page);
    await sendPrompt(composer, "run_background_job");

    const card = page.getByTestId("u3-bash-card").filter({ hasText: COMMAND });
    await expect(card).toContainText("In background", { timeout: 120_000 });
    await openToolCard(card);
    await card.getByRole("button", { name: /^Stop background job/ }).click();
    await expect(card).toContainText("Stopped", { timeout: 60_000 });
    await expect(card.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);

    await page.reload();
    const reopened = page.getByTestId("u3-bash-card").filter({ hasText: COMMAND });
    await expect(reopened).toBeVisible({ timeout: 120_000 });
    await expect(reopened).toContainText("Stopped", { timeout: 60_000 });
    await expect(reopened).not.toContainText("In background");
    await openToolCard(reopened);
    await expect(reopened.getByText("Running in the background", { exact: false })).toHaveCount(0);
    await expect(reopened.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);

    await mkdir(screenshots, { recursive: true });
    await waitForFiniteAnimations(page);
    await reopened.screenshot({ path: join(screenshots, "fix-1471-stopped-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await reopened.screenshot({ path: join(screenshots, "fix-1471-stopped-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#shell-sessions-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator("#shell-panels-sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator('[data-shell-drawer-backdrop="true"]')).toHaveCount(0);
    await waitForFiniteAnimations(page);
    await reopened.screenshot({ path: join(screenshots, "fix-1471-stopped-narrow.png") });
  },
);
