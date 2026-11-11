import type { Page } from "@playwright/test";
import { expect, realTest, startNewChat } from "./real-omp";

/**
 * The Models dialog's Web search page (#11, #12) on real omp: every engine of omp's says where its key comes from; a key
 * is typed masked, saved in omp's store, replaced and removed, and never shown again; an engine is put first and another
 * added after it, in the order omp resolves; nothing sits under the dialog's footer; and Settings leads there.
 */

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const hub = (page: Page) => page.getByRole("dialog", { name: "Models" });
const order = (page: Page) => hub(page).getByRole("region", { name: "Search order" });
const engine = (page: Page, id: string) => hub(page).locator(`[data-engine="${id}"]`);
const row = (page: Page, id: string) => engine(page, id).getByRole("button").first();

/** A made-up TinyFish key; its tail is what the page must never hold once saved. */
const TAIL = "e2e".repeat(8);
const KEY = `sk-tinyfish-${TAIL}`;

async function openWebSearch(page: Page): Promise<void> {
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  await box(page).press("Alt+m");
  await expect(hub(page)).toBeVisible();
  await hub(page)
    .getByRole("listbox", { name: "Roles" })
    .getByRole("option", { name: /^WEB Web search: / })
    .click();
  await expect(order(page)).toBeVisible({ timeout: 30_000 });
}

realTest.describe("new UI: the Web search page of the Models dialog", () => {
  realTest.setTimeout(240_000);

  realTest(
    "a key is typed masked, saved, replaced and removed, and the page never holds it",
    async ({ realApp }, testInfo) => {
      const page = await realApp.open({ path: "/" });
      await openWebSearch(page);
      await expect(row(page, "tinyfish")).toHaveAccessibleName(/^TinyFish: Needs a key/);
      // Keenable without a key searches only when picked: never shown as Keenable with a key.
      await expect(row(page, "keenable")).toHaveAccessibleName(
        /^Keenable: No key: searches only when picked/,
      );
      await page.screenshot({ path: testInfo.outputPath("1-engines.png") });

      await row(page, "tinyfish").click();
      const field = engine(page, "tinyfish").getByLabel("TinyFish API key");
      await expect(field).toHaveAttribute("type", "password");
      await expect(
        engine(page, "tinyfish").getByRole("link", { name: "Get a TinyFish key" }),
      ).toHaveAttribute("href", "https://agent.tinyfish.ai/api-keys");
      await field.fill(KEY);
      await engine(page, "tinyfish").getByRole("button", { name: "Save", exact: true }).click();
      // Saved, then checked with a real search, whatever that search answers here.
      await expect(engine(page, "tinyfish").getByRole("status")).toHaveText(/^Key saved\./);
      await expect(row(page, "tinyfish")).toHaveAccessibleName(/^TinyFish: Key saved/);
      await expect(engine(page, "tinyfish").getByRole("status")).not.toHaveText(/Checking it/, {
        timeout: 60_000,
      });
      await page.screenshot({ path: testInfo.outputPath("2-saved.png") });
      expect(await page.content()).not.toContain(TAIL);
      // Nor does any field still hold it (a typed value is not in the page's markup).
      expect(
        await page.evaluate(
          (tail) =>
            [...document.querySelectorAll("input")].some((input) => input.value.includes(tail)),
          TAIL,
        ),
      ).toBe(false);

      // Replace: the field opens again; the key saved before is gone once the new one is in.
      await engine(page, "tinyfish").getByRole("button", { name: "Replace key" }).click();
      await field.fill(`sk-tinyfish-${"r2".repeat(12)}`);
      await engine(page, "tinyfish").getByRole("button", { name: "Save", exact: true }).click();
      await expect(engine(page, "tinyfish").getByText("A key is saved in omp.")).toBeVisible({
        timeout: 60_000,
      });

      // Remove asks first, then omp no longer has it.
      await engine(page, "tinyfish").getByRole("button", { name: "Remove key" }).click();
      await engine(page, "tinyfish").getByRole("button", { name: "Remove", exact: true }).click();
      await expect(engine(page, "tinyfish").getByRole("status")).toHaveText("Key removed.");
      await expect(row(page, "tinyfish")).toHaveAccessibleName(/^TinyFish: Needs a key/);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "an engine goes first and another is added after it, in omp's order, and the order goes back to omp's defaults",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await openWebSearch(page);
      const back = order(page).getByRole("button", { name: "Back to omp's default fallbacks" });
      // No fallbacks of the role's own: omp's defaults follow the first, and nothing to go back from.
      await expect(order(page)).toContainText("(omp's default fallbacks)");
      await expect(back).toHaveCount(0);

      await row(page, "tinyfish").click();
      await engine(page, "tinyfish")
        .getByRole("button", { name: "Search with this first" })
        .click();
      await expect(order(page).getByRole("listitem").first()).toContainText("TinyFish", {
        timeout: 30_000,
      });
      await expect(row(page, "tinyfish")).toHaveAccessibleName(/, searches first$/);

      await row(page, "keenable").click();
      await engine(page, "keenable").getByRole("button", { name: "Add as a fallback" }).click();
      await expect(order(page).getByRole("listitem").last()).toContainText("Keenable", {
        timeout: 30_000,
      });
      await expect(back).toBeVisible();
      await expect(order(page)).not.toContainText("(omp's default fallbacks)");
      // Earlier swaps it with the one before it.
      const items = order(page).getByRole("listitem");
      const before = await items.count();
      await order(page).getByRole("button", { name: "Keenable earlier" }).click();
      await expect(items.nth(before - 2)).toContainText("Keenable", { timeout: 30_000 });

      await back.click();
      await expect(back).toHaveCount(0, { timeout: 30_000 });
      await expect(order(page)).toContainText("(omp's default fallbacks)");
      await expect(order(page)).not.toContainText("Keenable");
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "no engine sits under the dialog's footer, and a phone-wide window scrolls the page without overflowing sideways",
    async ({ realApp }, testInfo) => {
      const page = await realApp.open({ path: "/" });
      await openWebSearch(page);
      const close = hub(page).getByRole("button", { name: "Close" });
      const last = hub(page).locator("[data-engine]").last();
      await last.scrollIntoViewIfNeeded();
      const lastBox = await last.boundingBox();
      const closeBox = await close.boundingBox();
      expect(lastBox).not.toBeNull();
      expect(closeBox).not.toBeNull();
      if (lastBox !== null && closeBox !== null) {
        expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(closeBox.y);
      }
      await page.screenshot({ path: testInfo.outputPath("2b-desktop-end.png") });

      await page.setViewportSize({ width: 390, height: 844 });
      await row(page, "keenable").click();
      await expect(engine(page, "keenable").getByLabel("Keenable API key")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("3-phone.png") });
      expect(
        await hub(page).evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1),
      ).toBe(true);
      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("Settings' Providers tab opens the Web search page", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await startNewChat(page);
    await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Settings" });
    await sheet
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: /^Providers/ })
      .click();
    await sheet
      .getByRole("region", { name: "Web search keys" })
      .getByRole("button", { name: "Search engines…" })
      .click();
    await expect(sheet).toBeHidden();
    await expect(order(page)).toBeVisible({ timeout: 30_000 });
    await expect(row(page, "tinyfish")).toBeVisible();
    expect(realApp.problems).toEqual([]);
  });
});
