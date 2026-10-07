import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Issue #685. One turn of an agent loop is one message, and a real chat has turns of 1,400 steps:
 * mounting every step froze the page. A turn this long opens with its latest steps on screen and the
 * earlier ones behind one button. This is the real app opening a real omp session file with one turn
 * of 200 bash steps.
 */
realTest.use({ seedLongTurn: 200 });

realTest(
  "a turn of 200 steps opens with its latest 20 on screen and the earlier steps one click away",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await list.getByRole("option", { name: /Run the long job/ }).click();

    // 200 bash steps and the answer are 201 parts: the first 181 fold away.
    const fold = page.getByRole("button", { name: /earlier steps/ });
    await expect(fold).toHaveText("181 earlier steps", { timeout: 60_000 });
    await expect(fold).toHaveAttribute("aria-expanded", "false");
    const cards = page.locator('[data-slot="u3-bash-card"]');
    // The latest 20 parts are 19 steps and the answer.
    await expect(cards).toHaveCount(19);
    await expect(page.getByText("All 200 steps are done.")).toBeVisible();
    await expect(page.getByText("echo step-199", { exact: true })).toBeVisible();
    await expect(page.getByText("echo step-181", { exact: true })).toBeVisible();
    await expect(page.getByText("echo step-180", { exact: true })).toHaveCount(0);

    // The page holds the folded turn, not 200 cards: a few thousand elements, not tens of thousands.
    const folded = await page.evaluate(() => document.querySelectorAll("*").length);
    expect(folded).toBeLessThan(4_000);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "long-turn-folded.png") });

    // Opening the fold mounts the first 50 earlier steps, in order, and nothing else.
    await fold.click();
    await expect(fold).toHaveAttribute("aria-expanded", "true");
    await expect(cards).toHaveCount(19 + 50);
    await expect(page.getByText("echo step-0", { exact: true })).toBeVisible();
    await expect(page.getByText("echo step-49", { exact: true })).toBeVisible();
    await expect(page.getByText("echo step-50", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, "long-turn-open.png") });

    await page.getByRole("button", { name: "Show 50 more steps" }).click();
    await expect(cards).toHaveCount(19 + 100);
    await page.getByRole("button", { name: /Show all \d+ remaining/ }).click();
    await expect(cards).toHaveCount(200);

    // Closing it takes them off the page again.
    await fold.click();
    await expect(cards).toHaveCount(19);
  },
);
