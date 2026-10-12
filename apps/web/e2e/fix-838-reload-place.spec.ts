import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots } from "./real-omp";

/**
 * Issue #838. Reloading a long chat reopened it at its newest message, so the reader lost their place. This
 * is the real app with one chat holding a turn of 150 bash steps: the reader scrolls to the middle, reloads,
 * and must land on the same message, not the bottom.
 */
realTest.use({ seedLongTurn: 150 });

const VIEWPORT = '[data-slot="u1-thread-viewport"]';

realTest(
  "a reload returns the reader to the message they were reading in a long chat",
  async ({ realApp }) => {
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await list.getByRole("option", { name: /Run the long job/ }).click();
    await expect(page.getByText("All 150 steps are done.")).toBeVisible({ timeout: 60_000 });

    const viewport = page.locator(VIEWPORT);
    const distanceFromBottom = () =>
      viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    // Opening a chat from the list still starts at the newest message.
    expect(await distanceFromBottom()).toBeLessThanOrEqual(1);

    // Read from the middle of the turn: two frames let the browser fire the scroll event that saves the place.
    await viewport.evaluate(async (el) => {
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.4);
      const { promise, resolve } = Promise.withResolvers<void>();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      await promise;
    });
    const before = await viewport.evaluate((el) => el.scrollTop);
    // Each step starts as one line, so the folded turn is short: the reader must still be off the newest message.
    expect(await distanceFromBottom()).toBeGreaterThan(40);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-838-before-reload.png") });

    await page.reload();
    await expect(page.getByText("All 150 steps are done.")).toBeVisible({ timeout: 60_000 });
    // The reader is back where they were, within a few pixels, and not at the newest message.
    await expect
      .poll(async () => Math.abs((await viewport.evaluate((el) => el.scrollTop)) - before))
      .toBeLessThanOrEqual(8);
    expect(await distanceFromBottom()).toBeGreaterThan(40);
    await page.screenshot({ path: join(screenshots, "fix-838-after-reload.png") });
  },
);
