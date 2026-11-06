import { expect, realTest, startNewChat } from "./real-omp";
import { box, defineModelHubChecks, hub } from "./v2-model-hub-checks";

/** omp's model hub (Alt+M) in the new UI in Chromium (the config's Chrome), its palette entry, and its tour. */
defineModelHubChecks("chromium");

realTest.describe("new UI model hub, palette and tour", () => {
  realTest.setTimeout(240_000);

  realTest("the palette opens the Models dialog", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    await page.keyboard.press("Control+k");
    const search = page
      .getByRole("dialog", { name: "Palette", exact: true })
      .getByRole("combobox", { name: "Search the palette" });
    await search.fill("Models: give each role");
    await search.press("Enter");
    await expect(hub(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(hub(page)).toBeHidden();

    expect(realApp.problems).toEqual([]);
  });

  realTest(
    "the A model for each role tour waits for Alt+M and for the dialog to close",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const popover = page.locator(".driver-popover");
      const heading = popover.locator(".driver-popover-title");
      await page.keyboard.press("Control+k");
      const search = page
        .getByRole("dialog", { name: "Palette", exact: true })
        .getByRole("combobox", { name: "Search the palette" });
      await search.fill("Tour: A model for each role");
      await search.press("Enter");

      // The tour opens a new workspace with a new chat, so what it has you try touches none of your chats.
      await expect(heading).toHaveText("Models");
      const shown = box(page).filter({ visible: true });
      await expect(shown).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await shown.press("Alt+m");
      await expect(hub(page)).toBeVisible();
      await expect(heading).toHaveText("Each role's model");
      await page.keyboard.press("Escape");
      await expect(hub(page)).toBeHidden();
      await expect(popover).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "on a phone Models keeps the role's models and a picked model's roles in reach (#2838)",
    async ({ realApp, browser }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
      const page = await realApp.open({ path: "/", context });
      await expect(box(page)).toHaveAttribute("placeholder", /^(Fake Model|Message omp)/, {
        timeout: 120_000,
      });
      await page.getByRole("button", { name: "More" }).tap();
      await page
        .locator("[data-tour='plus-sheet']")
        .getByRole("button", { name: /^Model: / })
        .tap();
      await page.getByRole("button", { name: "Roles and models…" }).tap();
      await expect(hub(page)).toBeVisible();

      // Under the role's levels, compaction limit and fallbacks, its models still scroll into view.
      const models = hub(page).getByRole("listbox", { name: "Models" });
      const first = models.getByRole("option").first();
      await first.scrollIntoViewIfNeeded();
      await expect(first).toBeInViewport();

      // In the Models view a picked model stays in view with its roles' row.
      await hub(page)
        .getByRole("group", { name: "View" })
        .getByRole("button", { name: "Models" })
        .tap();
      await hub(page)
        .getByRole("listbox", { name: "Lists" })
        .getByRole("option", { name: /^fake, \d+$/ })
        .tap();
      const haiku = models.getByRole("option", { name: /^Claude Haiku 3, / });
      await haiku.tap();
      await haiku.scrollIntoViewIfNeeded();
      await expect(haiku).toBeInViewport();
      const chips = hub(page).getByRole("group", { name: "Roles for Claude Haiku 3" });
      await expect(chips).toBeInViewport();
      await expect(chips.getByRole("button", { name: "SMOL" })).toBeVisible();
      await context.close();
      expect(realApp.problems).toEqual([]);
    },
  );
});
