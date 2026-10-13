import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, realTest, screenshots, sendPrompt, waitForFiniteAnimations } from "./real-omp";

/**
 * Issue #1357 on real omp, as a guard. With the search "Seeded chat 2" active, the results show only chat 2, while the
 * open chat (chat 3) does not match the search and two real turns run (chat 3, then chat 2). This spec passes on main
 * too, so it does not prove the fix: when the open chat's turn finishes, the app re-reads the list with its search,
 * which hides the bug, and no signal in the UI or the server log tells a spec when a background chat's change was
 * handled. The fix's proof is the unit tests in `catalog.test.ts`: a changed chat outside the search is not added, and
 * a listed chat renamed out of the search leaves the results; both fail on main.
 */
const SEARCH = "Seeded chat 2";

realTest.use({ seedSessions: 3 });

realTest(
  "a chat that changes during a search is listed only when it matches the search",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const list = page.getByRole("listbox", { name: "Session list" });
    await expect(list.getByRole("option")).toHaveCount(3, { timeout: 60_000 });

    // Chat 3 is the open chat; the search below leaves it out of the results.
    await list.getByRole("option", { name: /^Seeded chat 3/ }).click();
    const composer = page.getByRole("textbox", { name: "Message input" });
    await expect(composer).toBeVisible({ timeout: 60_000 });
    const search = page.getByRole("textbox", { name: "Search sessions" });
    await search.fill(SEARCH);
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option", { name: /^Seeded chat 2/ })).toBeVisible();

    // A turn in the open chat (chat 3): the fake model answers "pong". Its change is published as chat 3's turn settles.
    await sendPrompt(composer, "run turn in three");
    const assistant = page.locator('[data-slot="u1-message-row"][data-role="assistant"]');
    await expect(assistant.filter({ hasText: "pong" })).toBeVisible({ timeout: 60_000 });

    // The match (chat 2) runs a turn after it: once its answer is shown, chat 3's earlier change has been handled.
    await list.getByRole("option", { name: /^Seeded chat 2/ }).click();
    await expect(
      page.locator('[data-slot="u1-message-row"]').filter({ hasText: "Seeded chat 2" }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await sendPrompt(composer, "run turn in two");
    await expect(assistant.filter({ hasText: "pong" })).toBeVisible({ timeout: 60_000 });

    // Chat 3 has changed twice and does not match the search: the results still hold only chat 2.
    await expect(list.getByRole("option")).toHaveCount(1);
    await expect(list.getByRole("option", { name: /^Seeded chat 3/ })).toHaveCount(0);
    await expect(search).toHaveValue(SEARCH);

    // Each capture is taken once the app's styles have loaded: the search field has its border.
    await mkdir(screenshots, { recursive: true });
    await expect(search).toHaveCSS("border-top-style", "solid");
    await page.screenshot({ path: join(screenshots, "fix-1357-search-light.png") });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await waitForFiniteAnimations(page);
    await expect(search).toHaveCSS("border-top-style", "solid");
    await page.screenshot({ path: join(screenshots, "fix-1357-search-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // At 390 px the sessions sidebar opens from its button; the search result is the same.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Show sessions sidebar" }).click();
    await expect(list.getByRole("option")).toHaveCount(1);
    await waitForFiniteAnimations(page);
    await expect(search).toHaveCSS("border-top-style", "solid");
    await page.screenshot({ path: join(screenshots, "fix-1357-search-narrow.png") });
  },
);
