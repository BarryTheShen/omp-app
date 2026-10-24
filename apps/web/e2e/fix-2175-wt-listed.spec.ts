import type { Locator, Page } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

/*
 * Issue 2175, S8: `/w` is omp's prefix pick for the `/wt` command (alias `/worktree`), per v18.12.6 autocomplete.ts:374-382, 385-477.
 * Enter on `/w` picks the row and inserts `/wt ` without sending. A second Enter on `/wt`, or Enter on `/worktree`,
 * sends it and the app asks first. Each question is cancelled here, so no chat moves. Real omp 18.12.2 on the test machine.
 */

realTest.use({
  seedWorkspace: { files: { "README.md": "# project\n" }, gitRepo: true },
});

/** The slash list above the composer (`trigger-slot.tsx`). */
function commandList(page: Page) {
  return page.getByRole("listbox", { name: "Slash commands" });
}

/** The question the app asks before `/wt`, whose accessible name is "Move to worktree". */
function moveQuestion(page: Page): Locator {
  return page.getByRole("dialog", { name: "Move to worktree" });
}

realTest(
  "S8: /w picks /wt; Enter inserts it without sending, and Enter on /wt or /worktree asks first",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    const composer = await startChat(page);

    await composer.pressSequentially("/w");
    const first = commandList(page).getByRole("option").first();
    await expect(first.locator("span.font-medium")).toHaveText("/wt", { timeout: 60_000 });
    await composer.press("Enter");
    // Enter inserts the row: the composer keeps `/wt ` and no question opens.
    await expect(composer).toHaveValue("/wt ");
    await expect(moveQuestion(page)).toHaveCount(0);

    // Enter sends `/wt`: the app asks first, and Cancel sends nothing.
    await composer.press("Enter");
    const question = moveQuestion(page);
    await expect(question, "/wt asks before omp runs it").toBeVisible({ timeout: 30_000 });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toHaveCount(0);

    // The alias typed in full sends the same command, which asks first too.
    await composer.pressSequentially("/worktree");
    await expect(first.locator("span.font-medium")).toHaveText("/wt", { timeout: 60_000 });
    await composer.press("Enter");
    await expect(question).toBeVisible({ timeout: 30_000 });
    await question.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(question).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
