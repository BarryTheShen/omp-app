import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

/**
 * The new UI's model menu on real omp with the fake models: each provider's newest models first; a star puts a model
 * under Favorites, on every page of the server and after a reload; a hidden model folds away under Hidden, where the
 * search still finds it and Show brings it back; Recent lists the models the chat switched to, newest first.
 */
const chats = (page: Page) => page.getByRole("navigation", { name: "Chats" });
const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const chip = (page: Page) => page.getByRole("button", { name: /^Model: / });
const search = (page: Page) => page.getByPlaceholder("Find a model");
const group = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const names = async (page: Page, name: string): Promise<string[]> =>
  (await group(page, name).getByRole("option").allTextContents()).map((text) => text.trim());

async function newChat(page: Page): Promise<void> {
  await chats(page).getByRole("button", { name: "New chat" }).click();
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
}

async function openMenu(page: Page): Promise<void> {
  await chip(page).click();
  await expect(group(page, "fake").getByRole("option").first()).toBeVisible({ timeout: 30_000 });
}

realTest.describe("new UI model menu", () => {
  realTest.setTimeout(240_000);

  realTest(
    "each provider's newest models come first; a star puts a model under Favorites on every page, also after a reload",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      const other = await realApp.open({ path: "/" });
      await newChat(other);
      await openMenu(other);
      await expect(group(other, "Favorites")).toHaveCount(0);

      await openMenu(page);
      const fake = await names(page, "fake");
      const at = (name: string) => fake.findIndex((text) => text.startsWith(name));
      expect(at("Claude Fable 5")).toBeGreaterThanOrEqual(0);
      expect(at("Claude Fable 5")).toBeLessThan(at("Claude Sonnet 3.5"));
      expect(at("Claude Sonnet 3.5")).toBeLessThan(at("Claude Haiku 3"));

      // omp's catalog has models of the same name under other providers: this is the fake provider's row.
      const fable = group(page, "fake").getByRole("option", {
        name: /^Claude Fable 5\s*claude-fable-5$/,
      });
      await fable.hover();
      await group(page, "fake")
        .getByRole("button", { name: "Star Claude Fable 5", exact: true })
        .click();
      await expect(group(page, "Favorites").getByRole("option")).toHaveText([/^Claude Fable 5/]);
      // The star is the server's: the other page, menu open, shows it too.
      await expect(group(other, "Favorites").getByRole("option")).toHaveText([/^Claude Fable 5/]);
      // A click on the star leaves the caret in the search.
      await expect(search(page)).toBeFocused();

      await page.reload();
      await expect(box(page)).toBeVisible({ timeout: 60_000 });
      await newChat(page);
      await openMenu(page);
      await expect(group(page, "Favorites").getByRole("option")).toHaveText([/^Claude Fable 5/]);
      await group(page, "Favorites").getByRole("option").click();
      await expect(chip(page)).toHaveAccessibleName("Model: Claude Fable 5");

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest(
    "a hidden model folds away under Hidden, the search still finds it, and Show brings it back",
    async ({ realApp }) => {
      const page = await realApp.open({ path: "/" });
      await newChat(page);
      await openMenu(page);
      // From the keyboard: a search that only the fake provider's Sonnet 3.5 matches highlights it, Alt+H hides it.
      await search(page).fill("fake sonnet 3.5");
      await expect(group(page, "fake").getByRole("option")).toHaveText([/^Claude Sonnet 3\.5/]);
      await page.keyboard.press("Alt+h");
      await expect(group(page, "fake")).toHaveCount(0);
      // The search still finds it, under Hidden.
      const hidden = group(page, "Hidden").getByRole("option", { name: /^Claude Sonnet 3\.5/ });
      await expect(hidden).toBeVisible();

      await search(page).fill("");
      expect(await names(page, "fake")).not.toContainEqual(
        expect.stringMatching(/^Claude Sonnet 3\.5/),
      );
      await expect(hidden).toHaveCount(0);
      await group(page, "Hidden").getByRole("option", { name: "Show 1 hidden model" }).click();
      await hidden.hover();
      await group(page, "Hidden")
        .getByRole("button", { name: "Show Claude Sonnet 3.5", exact: true })
        .click();
      await expect(group(page, "Hidden")).toHaveCount(0);
      expect(await names(page, "fake")).toContainEqual(
        expect.stringMatching(/^Claude Sonnet 3\.5/),
      );

      expect(realApp.problems).toEqual([]);
    },
  );

  realTest("Recent lists the models this chat switched to, newest first", async ({ realApp }) => {
    const page = await realApp.open({ path: "/" });
    await newChat(page);
    await openMenu(page);
    await group(page, "fake")
      .getByRole("option", { name: /^Claude Haiku 3/ })
      .click();
    await expect(chip(page)).toHaveAccessibleName("Model: Claude Haiku 3");
    // omp stamps each switch in whole seconds, a clock the test cannot set: the next switch waits for the next second.
    await page.waitForTimeout(1_100);
    await openMenu(page);
    await group(page, "fake")
      .getByRole("option", { name: /^Claude Fable 5/ })
      .click();
    await expect(chip(page)).toHaveAccessibleName("Model: Claude Fable 5");

    await openMenu(page);
    const recent = await names(page, "Recent");
    expect(recent.slice(0, 2)).toEqual([
      expect.stringMatching(/^Claude Fable 5/),
      expect.stringMatching(/^Claude Haiku 3/),
    ]);

    expect(realApp.problems).toEqual([]);
  });
});
