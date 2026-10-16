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

realTest.setTimeout(360_000);

const DESKTOP = { width: 1280, height: 1000 } as const;

function bashCard(page: Page, command: string): Locator {
  return page.getByTestId("u3-bash-card").filter({ hasText: command });
}

function jobRow(wait: Locator, command: string): Locator {
  return wait.locator("li").filter({ hasText: command });
}

async function expectStoppedTask(page: Page): Promise<Locator> {
  const wait = page.getByTestId("t5-wait-card");
  await expect(wait).toBeVisible({ timeout: 120_000 });
  await openToolCard(wait);
  const row = jobRow(wait, "long-job");
  await expect(row.getByText("Cancelled", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(row.getByRole("button", { name: /^Stop background job/ })).toHaveCount(0);
  return row;
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "a stopped Tasks row stays cancelled without Stop after the chat reloads",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize(DESKTOP);
    const composer = await startChat(page);

    await sendPrompt(composer, "run_stale_background");
    await expect(page.getByText("background jobs started")).toBeVisible({ timeout: 120_000 });
    await sendPrompt(composer, "wait_for_jobs");

    const wait = page.getByTestId("t5-wait-card");
    await expect(wait).toBeVisible({ timeout: 120_000 });
    await openToolCard(wait);
    await expect(wait.locator("li")).toHaveCount(3, { timeout: 120_000 });

    const command = "sleep 900; echo long-job";
    const row = jobRow(wait, "long-job");
    await expect(row.getByText("Running", { exact: true })).toBeVisible();
    const otherPage = await realApp.open();
    const session = otherPage
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /^run_stale_background/ });
    await expect(session).toBeVisible({ timeout: 120_000 });
    await session.click();
    const bash = bashCard(otherPage, command);
    await expect(bash).toContainText("In background", { timeout: 120_000 });
    await openToolCard(bash);
    const stop = bash.getByRole("button", { name: /^Stop background job bg_\d+$/ });
    await expect(stop).toHaveCount(1, { timeout: 120_000 });
    await stop.click();
    await expect(bash.getByRole("status")).toHaveText(/^Stopped background job bg_\d+\.$/, {
      timeout: 60_000,
    });

    await page.reload();
    await expectStoppedTask(page);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({
      path: join(screenshots, "fix-1642-kept-stop-light.png"),
      fullPage: true,
    });

    await page.evaluate(() => window.localStorage.setItem("omp-app.theme", "dark"));
    await page.reload();
    await expectStoppedTask(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({
      path: join(screenshots, "fix-1642-kept-stop-dark.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const narrowRow = await expectStoppedTask(page);
    await narrowRow.scrollIntoViewIfNeeded();
    await waitForFiniteAnimations(page);
    await expectStylesLoaded(page);
    await page.screenshot({
      path: join(screenshots, "fix-1642-kept-stop-390.png"),
      fullPage: true,
    });
    expect(realApp.problems).toEqual([]);
  },
);
