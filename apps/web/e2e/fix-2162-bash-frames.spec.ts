import type { Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 2162, PR #2331's review: a `!` command's row goes from its running state to its finished state without a moment
 * with no row, and the finished command is one row, not two. The page records every change of the command's rows from the
 * first row on, and the record is read at the end: a page that sent the command, and a page reloaded while it runs.
 */

realTest.setTimeout(240_000);

interface Count {
  readonly rows: number;
  readonly finished: number;
}

/** Records each change of the execution rows (count, and how many show their output) in an attribute of <html>. */
const WATCH = `
(() => {
  if (window.__rowWatchOn) return;
  window.__rowWatchOn = true;
  const log = [];
  let last = "";
  const record = () => {
    const rows = [...document.querySelectorAll('[data-slot="u1-execution-row"]')];
    const finished = rows.filter((row) => row.querySelector('[role="group"][aria-label="Output"]') !== null).length;
    const now = { rows: rows.length, finished };
    const key = JSON.stringify(now);
    if (key === last) return;
    last = key;
    log.push(now);
    document.documentElement.dataset.rowLog = JSON.stringify(log);
  };
  const start = () => {
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    record();
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
})();
`;

async function watchRows(page: Page): Promise<void> {
  await page.addInitScript(WATCH);
  await page.evaluate(WATCH);
}

async function readLog(page: Page): Promise<Count[]> {
  const raw = await page.locator("html").getAttribute("data-row-log");
  const log: Count[] = JSON.parse(raw ?? "[]");
  return log;
}

/** From the first row on, no recorded state has zero rows before the output shows, and no state has two rows. */
function expectNoGap(log: readonly Count[]): void {
  const first = log.findIndex((count) => count.rows > 0);
  expect(first).toBeGreaterThanOrEqual(0);
  const shown = log.findIndex((count) => count.finished > 0);
  expect(shown).toBeGreaterThanOrEqual(first);
  expect(log.slice(first, shown).filter((count) => count.rows === 0)).toEqual([]);
  expect(log.slice(first).filter((count) => count.rows > 1)).toEqual([]);
}

realTest(
  "a `!` command's row never goes empty on the page that sent it, and is one row once it has its output",
  async ({ realApp }) => {
    const page = await realApp.open();
    await watchRows(page);
    const composer = await startChat(page);
    await sendPrompt(composer, "!echo hi");
    const output = page.getByRole("group", { name: "Output" });
    await expect(output).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(1_500);
    expectNoGap(await readLog(page));
    await expect(page.locator('[data-slot="u1-execution-row"]')).toHaveCount(1);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a `!` command shows as running with Stop command, then as finished, on the page that sent it: the screenshots",
  async ({ realApp }, testInfo) => {
    const page = await realApp.open();
    await watchRows(page);
    const composer = await startChat(page);
    await sendPrompt(composer, "!sleep 6; echo hi");
    const row = page.locator('[data-slot="u1-execution-row"]');
    await expect(row).toContainText("Running");
    await expect(page.getByRole("button", { name: "Stop command" })).toBeVisible();
    await row.screenshot({ path: testInfo.outputPath("fix-2162-running-stop-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(400);
    await row.screenshot({ path: testInfo.outputPath("fix-2162-running-stop-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await row.screenshot({ path: testInfo.outputPath("fix-2162-running-stop-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    await expect(page.getByTestId("u1-execution-output")).toContainText("hi", { timeout: 25_000 });
    await expect(row).toContainText("Exit code 0");
    // The transcript entry replaces the row's record once omp's history is read: wait for its store key, not for a pause.
    await expect(
      page.locator('[data-slot="u1-message-row"][data-store-key^="entry:"]'),
    ).toHaveCount(1, {
      timeout: 25_000,
    });
    await row.screenshot({ path: testInfo.outputPath("fix-2162-finished-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(400);
    await row.screenshot({ path: testInfo.outputPath("fix-2162-finished-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await row.screenshot({ path: testInfo.outputPath("fix-2162-finished-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(1_500);
    expectNoGap(await readLog(page));
    await expect(row).toHaveCount(1);
  },
);

realTest(
  "a page reloaded while a `!` command runs shows no gap from its running row to its output, and is one row",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "!sleep 3; echo hi");
    await page.waitForTimeout(1_000);
    await watchRows(page);
    await page.reload();
    await expect(page.getByTestId("u1-execution-output")).toContainText("hi", { timeout: 25_000 });
    await page.waitForTimeout(1_500);
    expectNoGap(await readLog(page));
    await expect(page.locator('[data-slot="u1-execution-row"]')).toHaveCount(1);
  },
);

realTest(
  "a page reloaded after a `!` command ended shows its finished row once",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "!echo hi");
    await expect(page.getByTestId("u1-execution-output")).toContainText("hi", { timeout: 25_000 });
    await page.waitForTimeout(1_500);
    await page.reload();
    await expect(page.getByTestId("u1-execution-output")).toContainText("hi", { timeout: 25_000 });
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-slot="u1-execution-row"]')).toHaveCount(1);
    expect(realApp.problems).toEqual([]);
  },
);
