import type { Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/*
 * Issue 2175, S4: Tab completes a command and never sends it, as omp's editor does (editor.ts:1924-1947: Tab applies the
 * command name, Enter submits it). Enter then sends the command. Real omp 18.12.2 on the test machine.
 */

// omp 18.12.2 is at this path in every the test machine job.
realTest.use({ ompBinary: "/cache/bun/omp-18.12.2" });

/** The slash list above the composer (`trigger-slot.tsx`). */
function commandList(page: Page) {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/**
 * How long after Tab the check watches for a send. A send clears the composer after its round trip, so on main the text
 * is gone by then. Absence has no event to wait for, so this bounded wait is the check.
 */
const WATCH_AFTER_TAB_MS = 1_500;

realTest(
  "Tab completes /context without sending it, and Enter then sends it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("/context");
    const first = commandList(page).getByRole("option").first();
    await expect(first.locator("span.font-medium")).toHaveText("/context", { timeout: 60_000 });
    await composer.press("Tab");
    await expect(composer).toHaveValue("/context ");
    await expect(commandList(page).getByRole("option")).toHaveCount(0);
    // For a while after Tab the text stays, nothing is sent (the transcript is still empty), and no reply comes.
    await page.waitForTimeout(WATCH_AFTER_TAB_MS);
    await expect(composer).toHaveValue("/context ");
    await expect(page.getByText("No messages yet.", { exact: true })).toBeVisible();
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
    await composer.press("Enter");
    // Enter sends /context: the composer empties, and no model reply appears.
    await expect(composer).toHaveValue("", { timeout: 60_000 });
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
  },
);
