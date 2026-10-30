import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI's click-through tours (`apps/ui/src/tour`) on real omp: the "What's new" card offers them
 * once, the palette keeps them, and a tour waits for each thing it asks for (a key, a click on Next or Skip) before it
 * moves on.
 */
realTest.describe("new UI tours", () => {
  realTest.setTimeout(240_000);
  const boxes = (page: Page) => page.getByRole("textbox", { name: "Message" });
  const shown = (page: Page) => boxes(page).filter({ visible: true });
  const tabs = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
  const card = (page: Page) => page.getByRole("region", { name: "What's new" });
  const palette = (page: Page) => page.getByRole("dialog", { name: "Palette", exact: true });
  const popover = (page: Page) => page.locator(".driver-popover");
  const heading = (page: Page) => popover(page).locator(".driver-popover-title");
  const opened = async (page: Page, count: number) => {
    await expect(shown(page)).toHaveCount(count, { timeout: 60_000 });
    for (let index = 0; index < count; index += 1)
      await expect(shown(page).nth(index)).toHaveAttribute("placeholder", "Message omp", {
        timeout: 120_000,
      });
  };
  const startFromPalette = async (page: Page, title: string) => {
    await page.keyboard.press("Control+k");
    const search = palette(page).getByRole("combobox", { name: "Search the palette" });
    await search.fill(`Tour: ${title}`);
    await search.press("Enter");
    await expect(palette(page)).toBeHidden();
  };
  /** The tours the page has recorded as gone through to the end. */
  const doneTours = (page: Page) =>
    page.evaluate(() => {
      const kept: unknown = JSON.parse(localStorage.getItem("omp-app.ui.tours") ?? "null");
      return typeof kept === "object" && kept !== null && "done" in kept ? kept.done : undefined;
    });

  realTest(
    "the What's new card offers the tours once, and the palette keeps them",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await expect(card(page)).toBeVisible();
      await expect(card(page).getByRole("heading", { name: "New: guided tours" })).toBeVisible();
      await card(page).getByRole("button", { name: "Later" }).click();
      await expect(card(page)).toBeHidden();

      await page.reload();
      await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
      await expect(card(page)).toBeHidden();

      await page.keyboard.press("Control+k");
      const search = palette(page).getByRole("combobox", { name: "Search the palette" });
      await search.fill("Tour:");
      await expect(palette(page).getByRole("option")).toHaveText([
        /Tour: Your chats, tabs and panes/,
        /Tour: The message box/,
        /Tour: Inside a chat/,
        /Tour: Palette, keys and settings/,
        /Tour: Folders/,
        /Tour: Models and roles/,
        /Tour: Side questions/,
        /Tour: Side panel and usage/,
        /Tour: A model for each role/,
        /Tour: Agents and progress/,
      ]);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("the panes tour waits for each action and moves on", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startFromPalette(page, "Your chats, tabs and panes");
    const next = popover(page).getByRole("button", { name: "Next" });

    await expect(heading(page)).toHaveText("Your chats");
    await next.click();
    await expect(heading(page)).toHaveText("Find a chat");
    await next.click();
    await expect(heading(page)).toHaveText("A tab to try things in");
    // The tour made its own tab with a chat in it.
    await expect(tabs(page)).toHaveCount(2);
    await next.click();

    await expect(heading(page)).toHaveText("Split the screen");
    await opened(page, 1);
    await page.keyboard.press("Control+Shift+O");
    await opened(page, 2);
    await expect(heading(page)).toHaveText("Move between panes");
    await popover(page).getByRole("button", { name: "Skip" }).click();

    await expect(heading(page)).toHaveText("Zoom");
    await page.keyboard.press("Control+Shift+Enter");
    await expect(heading(page)).toHaveText("Zoom back");
    await page.keyboard.press("Control+Shift+Enter");
    await expect(heading(page)).toHaveText("Close a pane");

    await page.keyboard.press("Control+Shift+W");
    await expect(shown(page)).toHaveCount(1);
    await expect(heading(page)).toHaveText("Several chats at once");
    await next.click();
    await expect(heading(page)).toHaveText("Light or dark");
    await next.click();
    await expect(heading(page)).toHaveText("Done here");

    await page.keyboard.press("Control+Shift+Q");
    await expect(popover(page)).toHaveCount(0);
    // One tab is left, and a single tab shows no strip.
    await expect(tabs(page)).toHaveCount(0);
    await expect.poll(() => doneTours(page)).toEqual(["workspace-2026-10-30"]);

    expect(realApp.problems).toEqual([]);
  });

  realTest("Skip and close", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startFromPalette(page, "The message box");

    await expect(heading(page)).toHaveText("Write here");
    await popover(page).getByRole("button", { name: "Next" }).click();
    await expect(heading(page)).toHaveText("omp's commands");
    await popover(page).getByRole("button", { name: "Skip" }).click();
    await expect(heading(page)).toHaveText("Mention a file");

    await popover(page).getByRole("button", { name: "Close" }).click();
    await expect(popover(page)).toHaveCount(0);
    // The page takes keys again: nothing of the tour is left holding them.
    await page.keyboard.press("Control+k");
    await expect(palette(page)).toBeVisible();

    expect(realApp.problems).toEqual([]);
  });

  realTest("a tour started from the palette waits for it to be opened", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startFromPalette(page, "Palette, keys and settings");

    // The palette that started the tour is still closing as the tour begins; that does not count as opened.
    await expect(heading(page)).toHaveText("The palette");
    await page.keyboard.press("Control+k");
    await expect(heading(page)).toHaveText("Narrow it");
    await page.keyboard.press("Escape");
    await expect(heading(page)).toHaveText("Every key");

    expect(realApp.problems).toEqual([]);
  });
});
