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
  const list = (page: Page) => page.getByRole("dialog", { name: "What's new", exact: true });
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

      // The palette offers every tour, oldest first: the What's new list's updates from the bottom, each with its tours.
      await page.getByRole("button", { name: "What's new", exact: true }).click();
      await expect(list(page)).toBeVisible();
      const listed: string[] = [];
      for (const update of (await list(page).getByRole("region").all()).reverse()) {
        const labels = await update
          .getByRole("button", { name: /^Take the tour: / })
          .evaluateAll((buttons) =>
            buttons.map((button) => button.getAttribute("aria-label") ?? ""),
          );
        listed.push(...labels.map((label) => label.replace(/^Take the tour: /, "")));
      }
      await page.keyboard.press("Escape");
      await expect(list(page)).toBeHidden();
      await page.keyboard.press("Control+k");
      const search = palette(page).getByRole("combobox", { name: "Search the palette" });
      await search.fill("Tour:");
      const offered = palette(page).getByRole("option");
      await expect(offered).toHaveCount(listed.length);
      expect(
        (await offered.allTextContents()).map((text) => /Tour: (.+?)\s*\d+ min/.exec(text)?.[1]),
      ).toEqual(listed);

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

  /** Marks every tour offered with the card's Later, then takes `ids` back out: as after an update that brought them. */
  const afterUpdate = async (page: Page, ids: readonly string[]) => {
    await card(page).getByRole("button", { name: "Later" }).click();
    await page.evaluate((brought) => {
      const kept = JSON.parse(localStorage.getItem("omp-app.ui.tours") ?? "{}") as {
        offered?: string[];
        done?: string[];
      };
      kept.offered = (kept.offered ?? []).filter((id) => !brought.includes(id));
      localStorage.setItem("omp-app.ui.tours", JSON.stringify(kept));
    }, ids);
    await page.reload();
    await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
  };

  realTest(
    "after updates, the card names their new tours and shows them one after another",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await afterUpdate(page, ["notes-2026-10-30", "inbox-2026-10-30"]);
      await expect(card(page).getByRole("heading", { name: "New in 2 updates" })).toBeVisible();
      await expect(card(page).getByRole("listitem")).toHaveText([
        "Notes above the box",
        "Your inbox",
      ]);

      await card(page).getByRole("button", { name: "Take the tours" }).click();
      await expect(card(page)).toBeHidden();
      await expect(heading(page)).toHaveText("omp's short notes");
      await expect(popover(page).locator(".driver-popover-progress-text")).toHaveText(
        "Tour 1 of 2 · step 1 of 1",
      );
      await popover(page).getByRole("button", { name: "Next tour" }).click();
      await expect(heading(page)).toHaveText("The inbox");
      await page.getByRole("button", { name: "Inbox" }).click();
      await expect(heading(page)).toHaveText("Back to a chat");
      await popover(page).getByRole("button", { name: "Done" }).click();
      await expect(popover(page)).toHaveCount(0);
      await expect.poll(() => doneTours(page)).toEqual(["notes-2026-10-30", "inbox-2026-10-30"]);

      // Offered once: a reload shows no card for them.
      await page.reload();
      await expect(page.locator("[data-app-root='true']")).toBeVisible({ timeout: 30_000 });
      await expect(card(page)).toBeHidden();

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "What's new lists every update, newest first, and takes any of its tours again",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await card(page).getByRole("button", { name: "Later" }).click();

      await page.getByRole("button", { name: "What's new", exact: true }).click();
      await expect(list(page)).toBeVisible();
      // Newest first, by the time each update came.
      const came = await list(page)
        .getByRole("region")
        .locator("time")
        .evaluateAll((times) =>
          times.map((time) => Date.parse(time.getAttribute("datetime") ?? "")),
        );
      expect(came.length).toBeGreaterThan(1);
      expect(came.every((when, index) => index === 0 || when <= (came[index - 1] ?? when))).toBe(
        true,
      );

      await list(page).getByRole("button", { name: "Take the tour: Your inbox" }).click();
      await expect(list(page)).toBeHidden();
      await expect(heading(page)).toHaveText("The inbox");
      await page.getByRole("button", { name: "Inbox" }).click();
      await popover(page).getByRole("button", { name: "Done" }).click();
      await expect(popover(page)).toHaveCount(0);

      // The palette opens it too, and a tour taken shows as taken.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      const search = palette(page).getByRole("combobox", { name: "Search the palette" });
      await search.fill("What's new");
      await search.press("Enter");
      await expect(list(page)).toBeVisible();
      // A tour's own row, inside its update.
      const tourRow = (title: string) =>
        list(page).getByRole("region").getByRole("listitem").filter({ hasText: title });
      await expect(tourRow("Your inbox")).toContainText("Taken");
      await expect(tourRow("Your model menu")).not.toContainText("Taken");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("the What's new tour opens the list from its button", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startFromPalette(page, "Updates and their tours");
    await expect(heading(page)).toHaveText("Every update in one place");
    await page.getByRole("button", { name: "What's new", exact: true }).click();
    await expect(heading(page)).toHaveText("Take any tour again");
    await popover(page).getByRole("button", { name: "Done" }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(list(page)).toBeVisible();

    expect(realApp.problems).toEqual([]);
  });
});
