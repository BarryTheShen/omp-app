import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The workspaces at the top of the chat list, as Zen's sidebar lists spaces: one row each, the shown one selected; ＋
 * adds one, a double click renames, × closes. Workspaces, Pinned and Chats fold, and stay folded after a reload. While
 * the list is hidden the workspaces are tabs on top again.
 */
const nav = (page: Page) => page.getByRole("navigation", { name: "Chats" });
const listed = (page: Page) => nav(page).getByRole("tablist", { name: "Workspaces" });
const head = (page: Page, label: string) =>
  nav(page).getByRole("region", { name: label }).getByRole("button", { name: label, exact: true });

realTest.describe("workspaces in the chat list", () => {
  realTest.setTimeout(240_000);
  realTest.use({ seedSessions: 2 });

  realTest(
    "rows switch, add, rename and close workspaces; no strip on top while the list shows, tabs on top while it is hidden",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await startNewChat(page);
      await expect(page.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "placeholder",
        "Message omp",
        { timeout: 120_000 },
      );
      // One list of workspaces, in the chat list: the strip on top is gone.
      await expect(page.getByRole("tablist", { name: "Workspaces" })).toHaveCount(1);
      await expect(listed(page).getByRole("tab")).toHaveCount(1);

      await nav(page).getByRole("button", { name: "New workspace" }).click();
      await expect(listed(page).getByRole("tab")).toHaveCount(2);
      await expect(listed(page).getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");

      await listed(page).getByRole("tab").nth(1).dblclick();
      const name = nav(page).getByRole("textbox", { name: "Workspace name" });
      await name.fill("Notes");
      await name.press("Enter");
      await expect(listed(page).getByRole("tab", { name: "Notes" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await listed(page).getByRole("tab").first().click();
      await expect(listed(page).getByRole("tab").first()).toHaveAttribute("aria-selected", "true");

      // Hidden list: the workspaces are tabs on top, as before.
      await page.getByRole("button", { name: "Hide the chat list" }).click();
      const strip = page.getByRole("tablist", { name: "Workspaces" });
      await expect(strip.getByRole("tab", { name: "Notes" })).toBeVisible();
      await page.getByRole("button", { name: "Show the chat list" }).click();
      await expect(listed(page).getByRole("tab", { name: "Notes" })).toBeVisible();
      await expect(page.getByRole("tablist", { name: "Workspaces" })).toHaveCount(1);

      const notes = listed(page)
        .locator("div")
        .filter({ has: page.getByRole("tab", { name: "Notes" }) });
      await notes.hover();
      await notes.getByRole("button", { name: "Close workspace" }).click();
      await expect(listed(page).getByRole("tab")).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "Workspaces, Pinned and Chats fold, and stay folded after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(nav(page).getByRole("button", { name: "Seeded chat 1" })).toBeVisible({
        timeout: 120_000,
      });
      await head(page, "Workspaces").click();
      await expect(head(page, "Workspaces")).toHaveAttribute("aria-expanded", "false");
      await expect(listed(page)).toHaveCount(0);
      await head(page, "Chats").click();
      await expect(nav(page).getByRole("button", { name: "Seeded chat 1" })).toHaveCount(0);

      await page.reload();
      await expect(head(page, "Chats")).toHaveAttribute("aria-expanded", "false", {
        timeout: 120_000,
      });
      await expect(listed(page)).toHaveCount(0);
      // A search shows what it finds, folded or not.
      await nav(page).getByRole("searchbox", { name: "Search chats" }).fill("Seeded chat 2");
      await expect(nav(page).getByRole("button", { name: "Seeded chat 2" })).toBeVisible();
      await nav(page).getByRole("searchbox", { name: "Search chats" }).fill("");
      await head(page, "Chats").click();
      await head(page, "Workspaces").click();
      await expect(nav(page).getByRole("button", { name: "Seeded chat 1" })).toBeVisible();
      await expect(listed(page).getByRole("tab")).toHaveCount(1);
      expect(realApp.problems).toEqual([]);
    },
  );
});
