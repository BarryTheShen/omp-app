import { expect, realTest } from "./real-omp";
import { box, defineModelHubChecks, hub } from "./v2-model-hub-checks";

/** omp's model hub (Alt+M) in the new UI in Chromium (the config's Chrome), its palette entry, and its tour. */
defineModelHubChecks("chromium");

realTest.describe("new UI model hub, palette and tour", () => {
  realTest.setTimeout(240_000);

  realTest("the palette opens the Models dialog", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: "New chat" })
      .click();
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

      // The tour opens a new tab with a new chat, so what it has you try touches none of your chats.
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
});
