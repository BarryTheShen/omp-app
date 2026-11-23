import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * Fewer workspaces (V256): a chat opened from the list into a workspace of its own is a preview, which the next one
 * opened takes the place of, until you type in it; a workspace not in front for longer than Settings says closes by
 * itself, unless pinned.
 */
const nav = (page: Page) => page.getByRole("navigation", { name: "Chats" });
const rows = (page: Page) =>
  nav(page).getByRole("tablist", { name: "Workspaces" }).getByRole("tab");
const row = (page: Page, name: string) =>
  nav(page).getByRole("tablist", { name: "Workspaces" }).getByRole("tab", { name, exact: true });
const chat = (page: Page, name: string) => nav(page).getByRole("button", { name, exact: true });

/** Chat 1 in the first workspace's blank window; chat 2 in a workspace of its own, a preview. */
async function openTwo(page: Page): Promise<void> {
  await expect(chat(page, "Seeded chat 1")).toBeVisible({ timeout: 120_000 });
  await chat(page, "Seeded chat 1").click();
  await expect(row(page, "Seeded chat 1")).toBeVisible({ timeout: 60_000 });
  await expect(row(page, "Seeded chat 1")).not.toHaveAttribute("data-preview");
  await chat(page, "Seeded chat 2").click();
  await expect(row(page, "Seeded chat 2")).toHaveAttribute("data-preview", "", {
    timeout: 60_000,
  });
  await expect(rows(page)).toHaveCount(2);
}

realTest.describe("fewer workspaces", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 3 });

  realTest(
    "a chat opened from the list is a preview: the next one takes its place, until you type in it",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openTwo(page);

      // The next chat opened takes the preview's place: still two workspaces.
      await chat(page, "Seeded chat 3").click();
      await expect(row(page, "Seeded chat 3")).toHaveAttribute("data-preview", "", {
        timeout: 60_000,
      });
      await expect(row(page, "Seeded chat 3")).toHaveAttribute("aria-selected", "true");
      await expect(row(page, "Seeded chat 2")).toHaveCount(0);
      await expect(rows(page)).toHaveCount(2);

      // Typing in it keeps it: the next chat gets a workspace of its own.
      await page.getByRole("textbox", { name: "Message" }).fill("a draft");
      await expect(row(page, "Seeded chat 3")).not.toHaveAttribute("data-preview");
      await chat(page, "Seeded chat 2").click();
      await expect(row(page, "Seeded chat 2")).toHaveAttribute("data-preview", "", {
        timeout: 60_000,
      });
      await expect(rows(page)).toHaveCount(3);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a workspace not used for longer than Settings says closes by itself; a pinned one and the shown one stay, and Reopen brings it back",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openTwo(page);
      await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

      // Pin chat 1's workspace; chat 2's is shown.
      const first = nav(page)
        .getByRole("tablist", { name: "Workspaces" })
        .locator("div")
        // `has` looks inside each row: a locator from the row, not from the page's navigation.
        .filter({ has: page.getByRole("tab", { name: "Seeded chat 1", exact: true }) });
      await first.hover();
      await first.getByRole("button", { name: "Pin workspace" }).click();
      await expect(first.getByRole("button", { name: "Pin workspace" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // Chat 1's workspace to the front: chat 2's, a preview, is the one left behind.
      await row(page, "Seeded chat 1").click();
      await expect(row(page, "Seeded chat 1")).toHaveAttribute("aria-selected", "true");

      // Two days pass for every workspace (the page reads when each was last in front from this browser's storage).
      await page.evaluate(() => {
        const key = "omp-app.ui.workspace";
        const kept = JSON.parse(localStorage.getItem(key) ?? "{}") as {
          tabs: { usedAt?: number }[];
        };
        for (const tab of kept.tabs) tab.usedAt = Date.now() - 2 * 24 * 3_600_000;
        localStorage.setItem(key, JSON.stringify(kept));
      });
      await page.reload();

      // A little after the page opens (its check waits 10 s for the chats to say whether they work): one workspace
      // left. Right after the reload a workspace may not have its chat's name yet, so the count comes first.
      await expect(rows(page)).toHaveCount(1, { timeout: 60_000 });
      await expect(row(page, "Seeded chat 1")).toBeVisible();
      await expect(row(page, "Seeded chat 2")).toHaveCount(0);
      // Its chat is still in the list, no longer marked open in a window.
      await expect(chat(page, "Seeded chat 2")).toBeVisible({ timeout: 30_000 });

      // Closed as with ×: Reopen brings it back, kept.
      await page.keyboard.press("Control+Shift+T");
      await expect(row(page, "Seeded chat 2")).toBeVisible({ timeout: 60_000 });
      await expect(row(page, "Seeded chat 2")).not.toHaveAttribute("data-preview");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Settings → App → Workspaces sets how long, kept in this browser",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(chat(page, "Seeded chat 1")).toBeVisible({ timeout: 120_000 });
      const openApp = async (): Promise<void> => {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.locator('[data-tour="settings-tab-app"]').click();
      };
      await openApp();
      const pick = page.getByRole("combobox", { name: "Close workspaces not used for" });
      await expect(pick).toHaveText(/12 hours/, { timeout: 60_000 });
      await pick.click();
      await page.getByRole("option", { name: "Never" }).click();
      await expect(pick).toHaveText(/Never/);
      await page.reload();
      await expect(chat(page, "Seeded chat 1")).toBeVisible({ timeout: 120_000 });
      await openApp();
      await expect(
        page.getByRole("combobox", { name: "Close workspaces not used for" }),
      ).toHaveText(/Never/, { timeout: 60_000 });
      expect(realApp.problems).toEqual([]);
    },
  );
});
