import type { Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/*
 * Issue 2277: a spaced slash query lists only the argument completions of the command named exactly before the space, as
 * omp's editor does (v18.12.6 packages/tui/src/autocomplete.ts:690, 727-745). `/context ` names a command with no subcommands, so no list shows
 * and Enter sends it. `/extended-context ` preserves omp's subcommand order: its exact-argument completion items are
 * returned in provider order (v18.12.6 packages/tui/src/autocomplete.ts:740-745). Real omp 18.12.2 on the test machine.
 */

/** The slash list above the composer (`trigger-slot.tsx`). */
function commandList(page: Page) {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/**
 * How long after the space the check watches for rows. Absence has no event to wait for, so this bounded wait is the
 * check: the search for the typed text answers well inside it.
 */
const SETTLE_AFTER_SPACE_MS = 1_500;

realTest(
  "a spaced /context lists nothing: it names no subcommand, and extended-context, another command, is not offered",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("/context ");
    await expect(composer).toHaveValue("/context ");
    await page.waitForTimeout(SETTLE_AFTER_SPACE_MS);
    await expect(commandList(page).getByRole("option")).toHaveCount(0);
    // Enter sends the text as typed: the composer empties, and the model does not answer a command.
    await composer.press("Enter");
    await expect(composer).toHaveValue("", { timeout: 60_000 });
    await expect(page.getByText("pong", { exact: true })).toHaveCount(0);
  },
);

realTest(
  "a spaced /extended-context, a command named exactly, still lists its own subcommands",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);
    await composer.pressSequentially("/extended-context ");
    const options = commandList(page).getByRole("option");
    await expect(options).toHaveCount(3, { timeout: 60_000 });
    await expect(options.nth(0).locator("span.font-medium")).toHaveText("/extended-context on");
    await expect(options.nth(1).locator("span.font-medium")).toHaveText("/extended-context off");
    await expect(options.nth(2).locator("span.font-medium")).toHaveText("/extended-context status");
  },
);
