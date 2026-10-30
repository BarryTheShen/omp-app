import { expect, realTest } from "./real-omp";
import { box, defineBtwChecks, sheet } from "./v2-btw-checks";

/** omp's `/btw` in the new UI in Chromium (the config's Chrome), and the Side questions tour. */
defineBtwChecks("chromium");

realTest.describe("new UI side questions tour", () => {
  realTest.setTimeout(240_000);

  realTest(
    "the Side questions tour waits for /btw and for the sheet to be put away",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      const popover = page.locator(".driver-popover");
      const heading = popover.locator(".driver-popover-title");
      await page.keyboard.press("Control+k");
      const search = page
        .getByRole("dialog", { name: "Palette", exact: true })
        .getByRole("combobox", { name: "Search the palette" });
      await search.fill("Tour: Side questions");
      await search.press("Enter");

      // The tour opens a new tab with a new chat, so what it has you try touches none of your chats.
      await expect(heading).toHaveText("Ask on the side");
      const shown = box(page).filter({ visible: true });
      await expect(shown).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
      await shown.fill("/btw");
      await shown.press("Enter");
      await expect(shown).toHaveValue("/btw ");
      await shown.press("Enter");
      await expect(sheet(page)).toBeVisible();
      await expect(heading).toHaveText("Your side questions");

      await page.keyboard.press("Escape");
      await expect(sheet(page)).toBeHidden();
      await expect(heading).toHaveText("Find it again");
      await popover.getByRole("button", { name: "Done" }).click();
      await expect(popover).toHaveCount(0);

      expect(realApp.problems).toEqual([]);
    },
  );
});
