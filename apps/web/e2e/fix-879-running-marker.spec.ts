import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

realTest.setTimeout(300_000);
realTest.use({ seedSessions: 3 });

// The fake model runs `sleep 20` in bash and then a write, so this turn stays running for about twenty seconds.
const PROMPT = "run_queued_pair";
const NARROW = { width: 390, height: 844 } as const;
const WIDE = { width: 1280, height: 800 } as const;

function sessionList(page: Page): Locator {
  return page.getByRole("listbox", { name: "Session list" });
}

/**
 * Issue #879. A chat whose turn is still running shows a spinner and a screen-reader "Running" in the list, so a
 * person can see which chat is busy while they work in another one. The row shows the marker while the turn runs,
 * the marker goes when the turn ends, and the chat is finished when the person goes back to it.
 */
realTest(
  "a chat whose turn is still running shows a spinner and Running in the list, until the turn ends",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, PROMPT);
    // The turn has started: the chat is busy on the server, and the composer offers Stop.
    await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible({
      timeout: 60_000,
    });

    // The person works in another chat while this turn runs.
    await sessionList(page)
      .getByRole("option", { name: /Seeded chat 1/ })
      .click();
    const busyRow = sessionList(page).getByRole("option", { name: /run_queued_pair/ });
    await expect(busyRow.getByText("Running", { exact: true })).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(busyRow.locator('[data-slot="r1-session-running"]')).toBeVisible();

    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-879-running-light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-879-running-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize(NARROW);
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(busyRow.getByText("Running", { exact: true })).toHaveCount(1);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-879-running-narrow.png") });
    await page.setViewportSize(WIDE);

    // The turn ends: its chat's file is read again, so the row stops saying Running.
    await expect(busyRow.getByText("Running", { exact: true })).toHaveCount(0, {
      timeout: 60_000,
    });
    await busyRow.click();
    await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, {
      timeout: 60_000,
    });
    expect(realApp.problems).toEqual([]);
  },
);
